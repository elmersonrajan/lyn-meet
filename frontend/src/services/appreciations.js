/**
 * The four things a teacher can say to the whole class at once.
 *
 * Kept in step with the server's own list by hand rather than fetched: the
 * server is the one that decides what a given id means, and it refuses
 * anything it does not recognise. This side only needs the labels for the
 * buttons -- if the two ever drift, the worst case is a button that the
 * server declines, not a message nobody chose appearing on forty screens.
 */
export const APPRECIATIONS = [
  { id: "great-job", emoji: "\u{1F44F}", message: "Great Job!" },
  { id: "excellent", emoji: "\u{1F31F}", message: "Excellent!" },
  { id: "well-done", emoji: "\u{1F389}", message: "Well Done!" },
  { id: "outstanding", emoji: "\u{1F3C6}", message: "Outstanding!" },
];
