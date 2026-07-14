// A win: fanfare + confetti. Games call this instead of sfx.fanfare() so the
// two always fire together (and confetti stays reduced-motion aware).
import { burst } from "./fx";
import { sfx } from "./sfx";

export function celebrate(originEl?: Element | null): void {
  sfx.fanfare();
  burst(originEl);
}
