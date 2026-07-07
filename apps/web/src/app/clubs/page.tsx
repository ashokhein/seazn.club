// Clubs merged into the unified Directory (People + Clubs tabs).
import { redirect } from "next/navigation";

export default function ClubsPage() {
  redirect("/directory?tab=clubs");
}
