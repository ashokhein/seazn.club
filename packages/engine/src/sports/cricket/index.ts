// Cricket SportModule — spec 04 §2 + engine/sports/cricket.md (PROMPT-05).
export {
  cricket,
  CricketCfg,
  CricketEv,
  CricketBall,
  CricketInningsSummary,
  CricketToss,
  CricketRevise,
  CricketPlayerLine,
  // W4 domain audit — see DOMAIN.md.
  CricketClose,
  CricketWicket,
  CricketRetire,
  CricketNewBall,
  CricketPowerplay,
  CricketReview,
  type CricketBallEv,
  type CricketState,
  type InningsState,
  type FieldingCredit,
  type PowerplayBlock,
  type ReviewLedger,
} from "./cricket.ts";
// `resources` is the RAW table primitive (six-ball overs, ten-wicket innings).
// Anything holding cfg-scaled quantities must use `resourcesFromBalls` (#451).
export {
  DLS_STANDARD_TABLE,
  DLS_G50,
  DLS_EDITION,
  DLS_TABLE_BALLS_PER_OVER,
  DLS_TABLE_WICKETS,
  resources,
  resourcesFromBalls,
  dlsTarget,
  dlsPar,
} from "./dls.ts";
