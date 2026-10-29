const test = require("node:test");
const assert = require("node:assert");
const L = require("../lib.js");

test("isLeader is case-insensitive", () => {
  assert.ok(L.isLeader("A@x.com", ["a@X.com"]));
  assert.ok(!L.isLeader("b@x.com", ["a@x.com"]));
  assert.ok(!L.isLeader(null, ["a@x.com"]));
});

test("rowsToObjects", () => {
  const r = L.rowsToObjects([["ID", "Name"], ["1", "Camp"], ["", ""], ["2"]]);
  assert.deepStrictEqual(r, [{ id: "1", name: "Camp" }, { id: "2", name: "" }]);
});

test("safeCell prevents formulas", () => {
  assert.strictEqual(L.safeCell("=1+1"), "'=1+1");
  assert.strictEqual(L.safeCell("hi"), "hi");
});

test("scale and combine recipes", () => {
  const a = L.scaleRecipe(["1 1/2 cups flour", "2 eggs"], 4, 8);
  assert.deepStrictEqual(a[0], { qty: 3, unit: "cup", item: "flour" });
  const list = L.shoppingList([...a, ...L.scaleRecipe(["1 cup flour"], 1, 2)]);
  assert.strictEqual(L.formatIngredient(list.find((i) => i.item === "flour")), "5 cup flour");
  assert.throws(() => L.scaleRecipe(["1 egg"], 0, 2));
});
