// Structured clients send only user text and bounded choices. Trusted guidance
// is composed here after validating those choices; it is not moderation input.
export const isUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const views = {
  side: 'side view, full subject in profile',
  front: 'front view, subject facing the viewer',
  wide: 'wide view, smaller subject within its surroundings',
  close: 'close view, subject filling most of the page, no cropping',
  elevated: 'elevated view, looking down at the scene',
};
export function structuredComposition(input) {
  if (!isUUID(input.batchID) || typeof input.description !== 'string' || !input.description.trim() ||
      !Number.isInteger(input.age) || input.age < 3 || input.age > 18 ||
      !Object.hasOwn(views, input.composition) || Object.hasOwn(input, 'subject')) return null;
  const description = input.description.trim();
  const complexity = input.age <= 5 ? 'very simple outlines, a few large enclosed coloring areas, few objects, minimal background detail.'
    : input.age <= 8 ? 'simple clear outlines, large enclosed coloring areas, several objects, light background detail.'
    : input.age <= 12 ? 'moderately detailed outlines, varied medium coloring areas, several objects and a detailed background.'
    : 'intricate outlines, smaller enclosed coloring areas, many fine details and a rich, layered scene.';
  const subject = description + '\n\nComplexity: ' + complexity + '\n\nComposition preference: ' + views[input.composition] + '. Preserve the subject; explicit user instructions take priority.';
  return subject.length <= 500 ? {description, subject, batchID: input.batchID} : null;
}
