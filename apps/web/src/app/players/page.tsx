// Players tab of the unified Directory (Players + Clubs).
import { redirect } from "next/navigation";

export default function PlayersPage() {
  redirect("/directory?tab=players");
}
