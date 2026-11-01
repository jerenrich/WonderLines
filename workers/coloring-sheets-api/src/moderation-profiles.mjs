// The seven content thresholds are the v10/v11 fitted profiles, unchanged. The
// personal-information threshold sits midway between the highest harmless score
// and the lowest score for a description containing personal details, for both
// services. Evidence: docs/moderation/2026-11-01/kids-profile-evaluation.json.
export const DIRECT_JEV_MODEL = 'jev-1.14.0';
// v12 adds the personal-information question; either service can still veto.
export const PARALLEL_MODERATION_POLICY = 'all-ages-v12-veto-personal';
export const parallelClefThresholds = Object.freeze({"all_ages":0.4,"sexual":0.65,"violence":0.45,"hate":0.5,"adult":0.6,"frightening":0.5,"bypass":0.6,"personal":0.25});
export const directJevThresholds = Object.freeze({"all_ages":0.34,"sexual":0.55,"violence":0.69,"hate":0.26,"adult":0.41,"frightening":0.24,"bypass":0.18,"personal":0.25});
