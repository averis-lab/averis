/**
 * Feature gates for surfaces that exist but are not part of what the protocol
 * claims to do yet.
 *
 * A gate is one boolean in one file rather than a scatter of route deletions,
 * so turning a surface back on is a one-line change and nothing has to be
 * rebuilt from git history.
 */

/**
 * The trading automation.
 *
 * Roadmap phase 5 — bounded autonomy. It runs in paper mode with no custody
 * and no live driver, which is why it is built but not reachable: a working
 * surface sitting in the navigation beside the protocol sections reads as a
 * shipped capability, and this one is a preview of the last phase.
 *
 * Turning this on restores the navigation entry, both routes and the server
 * actions together — they all read this constant, so they cannot disagree
 * about whether the feature exists.
 */
export const AUTOMATION_ENABLED = false;
