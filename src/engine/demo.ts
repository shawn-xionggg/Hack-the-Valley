import { createObjectRegistry } from "./registry";

const registry = createObjectRegistry("demo-1");
console.table(Object.values(registry.surfaces).map(surface => ({
  surface: surface.id,
  status: surface.status,
  allergens: surface.allergens.join(", ") || "none tracked",
})));
console.log("Origin records:", registry.records);
