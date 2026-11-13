import { expect } from "bun:test";

const CUSTOM_CATEGORIES: Record<string, string> = { provider: "_provider", fast: "_fast", ultrafast: "_ultrafast" };

// ACP clients take the first `model`-category select as the model picker, so
// `model` must lead the list and be the only select carrying that category.
export function expectModelFirst(configOptions: any[] | undefined, { present = [] as string[] } = {}) {
  if (!Array.isArray(configOptions)) throw new Error(`configOptions is not an array: ${JSON.stringify(configOptions)}`);
  const ids = configOptions.map((option: any) => option.id);
  expect(ids[0]).toBe("model");
  const modelCategory = configOptions.filter((option: any) => option.category === "model");
  expect(modelCategory.map((option: any) => option.id)).toEqual(["model"]);
  expect(modelCategory[0].type).toBe("select");
  for (const id of present) {
    if (!ids.includes(id)) throw new Error(`expected configOptions to include "${id}", got [${ids.join(", ")}]`);
  }
  for (const option of configOptions) {
    const category = CUSTOM_CATEGORIES[option.id];
    if (category) expect({ id: option.id, category: option.category }).toEqual({ id: option.id, category });
  }
}
