const test = require("node:test");
const assert = require("node:assert");
const L = require("../docs/lib.js");

test("scale and combine recipes", () => {
  const a = L.scaleRecipe(["1 1/2 cups flour", "2 eggs"], 4, 8);
  assert.deepStrictEqual(a[0], { qty: 3, unit: "cup", item: "flour" });
  const list = L.shoppingList([...a, ...L.scaleRecipe(["1 cup flour"], 1, 2)]);
  assert.strictEqual(L.formatIngredient(list.find((i) => i.item === "flour")), "5 cup flour");
  assert.throws(() => L.scaleRecipe(["1 egg"], 0, 2));
});
