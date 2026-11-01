/**
 * A minimal reader for SvelteKit's `devalue` wire format -- what a
 * `__data.json` route returns (`{"type":"data","nodes":[{"type":"data",
 * "data":[...]}, ...]}`), which Do215's rebuilt site serves its day listings
 * through.
 *
 * `data` is a flat array. Element 0 is the root value; every other element is
 * a value that something else references *by index*:
 *
 * - a number, string, boolean or null element is itself;
 * - an object element maps each key to the index of its value;
 * - an array element whose first item is a number lists the indices of its
 *   items (so an array of strings is an array of indices pointing at strings);
 * - an array element whose first item is a *string* is a tagged special value
 *   (`["Date", "2026-..."]`, `["Set", ...]`, ...);
 * - a negative index is a sentinel: -1 undefined, -2 NaN, -3 Infinity,
 *   -4 -Infinity, -5 -0, -6 a hole in a sparse array.
 *
 * This reads only what plain JSON data needs. Date becomes its ISO string.
 * Anything else a tag could mean (Set, Map, BigInt, RegExp, null-prototype
 * objects) throws, because Do215 sending one means the payload changed and a
 * loud failure -- which `collectDo215` records as a failed request, so a total
 * break still surfaces as "every request failed" -- beats a silent misread.
 *
 * Repeated references resolve to the same decoded object (as devalue does),
 * which also makes a cyclic payload terminate instead of recursing forever.
 */

export class DevalueError extends Error {
  override name = "DevalueError";
}

const SENTINELS = new Map<number, unknown>([
  [-1, undefined],
  [-2, Number.NaN],
  [-3, Number.POSITIVE_INFINITY],
  [-4, Number.NEGATIVE_INFINITY],
  [-5, -0],
  [-6, undefined],
]);

export function unflatten(flat: unknown): unknown {
  if (!Array.isArray(flat) || flat.length === 0) throw new DevalueError("devalue payload is not a non-empty array");
  const table = flat as unknown[];
  const done = new Map<number, unknown>();

  const resolve = (index: unknown): unknown => {
    if (typeof index !== "number" || !Number.isInteger(index)) {
      throw new DevalueError(`devalue reference ${JSON.stringify(index)} is not an integer index`);
    }
    if (index < 0) {
      if (!SENTINELS.has(index)) throw new DevalueError(`unknown devalue sentinel ${String(index)}`);
      return SENTINELS.get(index);
    }
    if (index >= table.length) throw new DevalueError(`devalue index ${String(index)} is out of range (${String(table.length)} entries)`);
    if (done.has(index)) return done.get(index);

    const value = table[index];
    if (value === null || typeof value !== "object") {
      done.set(index, value);
      return value;
    }
    if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        const tag = value[0];
        if (tag === "Date" && typeof value[1] === "string") {
          done.set(index, value[1]);
          return value[1];
        }
        throw new DevalueError(`unsupported devalue type "${tag}"`);
      }
      const out: unknown[] = [];
      done.set(index, out); // register before descending so a cycle resolves
      for (const item of value) out.push(resolve(item));
      return out;
    }
    const out: Record<string, unknown> = {};
    done.set(index, out);
    for (const [key, ref] of Object.entries(value)) out[key] = resolve(ref);
    return out;
  };

  return resolve(0);
}
