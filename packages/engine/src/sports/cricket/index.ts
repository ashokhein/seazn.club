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
export { DLS_STANDARD_TABLE, DLS_G50, DLS_EDITION, resources, dlsTarget, dlsPar } from "./dls.ts";
