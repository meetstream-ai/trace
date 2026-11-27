import { redirect } from "next/navigation";
import { meetingPath } from "@/lib/navigation";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (typeof query.meeting === "string")
    redirect(
      `${meetingPath(query.meeting)}${typeof query.segment === "string" ? `?segment=${encodeURIComponent(query.segment)}` : ""}`,
    );
  redirect("/workspace/meetings");
}
