(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TroopLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Parse "2 cups flour" / "1/2 tsp salt" / "3 eggs" into {qty, unit, item}.
  const UNITS = ["cups", "cup", "tbsp", "tsp", "oz", "lb", "lbs", "g", "kg", "ml", "l", "can", "cans", "pkg", "pkgs"];
  function parseQty(tok) {
    if (/^\d+\/\d+$/.test(tok)) { const [a, b] = tok.split("/").map(Number); return b ? a / b : NaN; }
    if (/^\d+(\.\d+)?$/.test(tok)) return Number(tok);
    return NaN;
  }
  function parseIngredient(line) {
    const toks = String(line).trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    let qty = 0, i = 0;
    while (i < toks.length && !isNaN(parseQty(toks[i]))) { qty += parseQty(toks[i]); i++; }
    if (i === 0) return { qty: 0, unit: "", item: toks.join(" ").toLowerCase() };
    let unit = "";
    if (i < toks.length && UNITS.includes(toks[i].toLowerCase())) { unit = toks[i].toLowerCase().replace(/^(cup|can|pkg|lb)s$/, "$1"); i++; }
    const item = toks.slice(i).join(" ").toLowerCase();
    return item ? { qty, unit, item } : null;
  }

  // Scale a recipe (array of ingredient lines) from `from` servings to `to` servings.
  function scaleRecipe(lines, from, to) {
    const f = Number(to) / Number(from);
    if (!isFinite(f) || f <= 0) throw new Error("Invalid servings");
    return lines.map(parseIngredient).filter(Boolean)
      .map((p) => ({ ...p, qty: Math.round(p.qty * f * 100) / 100 }));
  }

  // Combine ingredients from several scaled recipes into one shopping list.
  function shoppingList(ingredients) {
    const map = new Map();
    for (const ing of ingredients) {
      const key = ing.item + "|" + ing.unit;
      map.set(key, { ...ing, qty: (map.get(key)?.qty || 0) + ing.qty });
    }
    return [...map.values()]
      .map((i) => ({ ...i, qty: Math.round(i.qty * 100) / 100 }))
      .sort((a, b) => a.item.localeCompare(b.item));
  }

  function formatIngredient(i) {
    return [i.qty || "", i.unit, i.item].filter((x) => x !== "").join(" ");
  }

  return { parseIngredient, scaleRecipe, shoppingList, formatIngredient };
});
