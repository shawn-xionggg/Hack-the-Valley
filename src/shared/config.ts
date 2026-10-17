// GhostTrace shared configuration — single source of truth for object IDs,
// surfaces, zones, orders, and tunable thresholds.
// Spec: GhostTrace-summary-v4.md ("Shared Integration Contract").

export const ALLERGENS = ["peanut"] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const OBJECT_IDS = [
  "hands",
  "peanut-source",
  "tongs-tip",
  "tongs-handle",
  "meal-1",
  "wash-station",
] as const;
export type ObjectId = (typeof OBJECT_IDS)[number];

/** Surfaces a hand can make propagating contact with (never "hands" or "wash-station"). */
export type ContactTarget = Exclude<ObjectId, "hands" | "wash-station">;

/** Surfaces the engine tracks exposure for (everything except the wash station). */
export type ExposableSurfaceId = Exclude<ObjectId, "wash-station">;

/** Objects that have a calibrated zone on the table (everything except hands). */
export type ZonedObjectId = Exclude<ObjectId, "hands">;

export type UtensilId = "tongs";
export type MealId = "meal-1";

export type ObjectKind =
  | "hands"
  | "allergen-source"
  | "utensil-surface"
  | "meal"
  | "wash-station";

/** Normalized image coordinates: x and y in [0, 1], origin top-left of the RAW camera frame (not a mirrored display). */
export type Point = [x: number, y: number];
export type Polygon = Point[];

export interface TrackedSurface {
  id: ObjectId;
  kind: ObjectKind;
  label: string;
  utensilId?: UtensilId; // set only on utensil surfaces
  initialAllergens: Allergen[]; // non-empty only on allergen sources
}

export const SURFACES: Record<ObjectId, TrackedSurface> = {
  hands: { id: "hands", kind: "hands", label: "Worker's hands", initialAllergens: [] },
  "peanut-source": {
    id: "peanut-source",
    kind: "allergen-source",
    label: "Peanut source (simulated)",
    initialAllergens: ["peanut"],
  },
  "tongs-tip": {
    id: "tongs-tip",
    kind: "utensil-surface",
    label: "Tong tips",
    utensilId: "tongs",
    initialAllergens: [],
  },
  "tongs-handle": {
    id: "tongs-handle",
    kind: "utensil-surface",
    label: "Tong handle",
    utensilId: "tongs",
    initialAllergens: [],
  },
  "meal-1": { id: "meal-1", kind: "meal", label: "Meal for Order #4", initialAllergens: [] },
  "wash-station": {
    id: "wash-station",
    kind: "wash-station",
    label: "Wash station (wet wipes)",
    initialAllergens: [],
  },
};

export const UTENSILS: Record<UtensilId, readonly ContactTarget[]> = {
  tongs: ["tongs-tip", "tongs-handle"],
};

export interface Order {
  id: string;
  displayName: string;
  mealId: MealId;
  allergies: Allergen[];
}

export const ORDERS: Order[] = [
  { id: "order-4", displayName: "Order #4", mealId: "meal-1", allergies: ["peanut"] },
];

/** Zone layout, filled in by the calibration screen and persisted to localStorage/JSON. */
export type ZoneLayout = Record<ZonedObjectId, Polygon>;
export const ZONE_LAYOUT_STORAGE_KEY = "ghosttrace.zones.v1";

export interface Tuning {
  /** Fingertip must stay in a zone this long before one contact event fires. */
  contactDwellMs: number;
  /** Fingertip must leave a zone for this long before the next contact with it can fire. */
  contactExitMs: number;
  /** Contacts below this confidence are logged but have no effect. */
  minContactConfidence: number;
  /** Continuous presence in the wash zone needed for a zone-dwell wash. */
  washDwellMs: number;
  /** MediaPipe fingertip landmark indices used for zone overlap. */
  fingertipLandmarks: readonly number[];
}

export const DEFAULT_TUNING: Tuning = {
  contactDwellMs: 400,
  contactExitMs: 300,
  minContactConfidence: 0.6,
  washDwellMs: 6000,
  fingertipLandmarks: [4, 8, 12, 16, 20], // thumb, index, middle, ring, pinky tips
};
