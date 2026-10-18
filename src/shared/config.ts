// Allos shared configuration — single source of truth for object IDs,
// surfaces, zones, orders, and tunable thresholds.
// Spec: Allos-summary-v5.md ("Shared Integration Contract").

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
    label: "Sink (simulated)", // A3: a marked sink prop replaced the wet-wipe station; the id is unchanged
    initialAllergens: [],
  },
};

export const UTENSILS: Record<UtensilId, readonly ContactTarget[]> = {
  tongs: ["tongs-tip", "tongs-handle"],
};

/** Utensil parts that are tracked and can act in a contact. */
export type ToolSurface = "tongs-tip" | "tongs-handle";

/** Who can initiate a contact: the hands, or a tracked tong part. */
export type ContactActor = "hands" | ToolSurface;

/** Static targets a tracked tool can touch (never another tool part). */
export type ToolContactTarget = Exclude<ContactTarget, ToolSurface>; // "peanut-source" | "meal-1"

// Amendment A1 (signed off Sat Oct 17): replaces v5's single-marker UtensilModel.
/**
 * One marker's view of a utensil, in that marker's LOCAL coordinates (marker square = [-0.5, 0.5]^2).
 * Calibrated with this marker's face up; vision maps it into the raw frame with the marker's homography.
 */
export interface UtensilMarkerModel {
  markerId: number;
  parts: Record<ToolSurface, Polygon>;
  /** Jaw ends. Tool contacts test only these points, not the whole tip polygon. */
  tipContactPoints: Point[];
  /**
   * A4: touch references. This marker's mean side (in units of frame height, as vision measures its pose)
   * recorded while the jaw ends rested on each target. A tool contact with a target counts only frames where
   * the side is at most (1 + Tuning.toolContactSideMargin) × its reference: a bigger marker is closer to the
   * camera. A target with no reference has no height gate (hover counts, as before A4).
   */
  touchSides?: Partial<Record<ToolContactTarget, number>>;
}

/**
 * The tong arms are stacked when held, so each arm's outer face carries its own marker and only one
 * faces the camera at a time. Vision places the tongs from whichever is visible; it never averages them.
 */
export interface UtensilModel {
  markers: UtensilMarkerModel[];
}
export type UtensilModels = Partial<Record<UtensilId, UtensilModel>>;
// Storage keys keep the project's old name (GhostTrace), so calibrations saved before the rename still load.
export const UTENSIL_MODELS_STORAGE_KEY = "ghosttrace.utensils.v2";

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
  /** Keep the last utensil pose this long after its marker disappears ("held"). */
  utensilHoldMs: number;
  /** While a contact pair stays occupied, emit a fresh contact this often. */
  heldContactRefireMs: number;
  /** A3: lost-tracking gap a utensil-wash dwell tolerates; tracked and held frames never count as gaps. */
  utensilWashGapMs: number;
  /**
   * A4: height gate. A jaw end counts as inside a target only while the marker's side is at most (1 + this) ×
   * its touch reference for that target. 0.08 ≈ 4–5 cm above the touch height with the camera ~65 cm up.
   */
  toolContactSideMargin: number;
}

export const DEFAULT_TUNING: Tuning = {
  contactDwellMs: 400,
  contactExitMs: 300,
  minContactConfidence: 0.6,
  washDwellMs: 6000,
  fingertipLandmarks: [4, 8, 12, 16, 20], // thumb, index, middle, ring, pinky tips
  utensilHoldMs: 500,
  heldContactRefireMs: 1000,
  utensilWashGapMs: 1500, // A3: tune on the rig
  toolContactSideMargin: 0.08, // A4: tune 0.06–0.12 on the rig (G1–G4)
};
