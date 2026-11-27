import { safeReturnTo } from "@/lib/auth";
import Login from "@/components/login";
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  return <Login next={safeReturnTo((await searchParams).next)} />;
}
