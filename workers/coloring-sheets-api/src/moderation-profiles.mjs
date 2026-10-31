// Fitted only on calibration examples; holdout evaluated separately.
// Evidence: docs/moderation/2026-10-31/parallel-calibration-report.json; fixture SHA-256 a5eacac0c15bbe87f31dc5c04593db5b080efff547432499253f72d97c542f9c.
export const DIRECT_JEV_MODEL = 'jev-1.14.0';
// v11 keeps the v10 profiles and changes only the gate: either service can veto.
export const PARALLEL_MODERATION_POLICY = 'all-ages-v11-veto-0d745969007c';
export const parallelClefThresholds = Object.freeze({"all_ages":0.4,"sexual":0.65,"violence":0.45,"hate":0.5,"adult":0.6,"frightening":0.5,"bypass":0.6});
export const directJevThresholds = Object.freeze({"all_ages":0.34,"sexual":0.55,"violence":0.69,"hate":0.26,"adult":0.41,"frightening":0.24,"bypass":0.18});
