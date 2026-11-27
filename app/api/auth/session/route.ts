import { user, failure } from "@/lib/server";
export async function GET(req: Request) {
  try {
    await user(req);
    return Response.json(
      { signedIn: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
