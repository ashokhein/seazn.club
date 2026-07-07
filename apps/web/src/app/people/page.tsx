// People merged into the unified Directory (People + Clubs tabs).
import { redirect } from "next/navigation";

export default function PeoplePage() {
  redirect("/directory?tab=people");
}
