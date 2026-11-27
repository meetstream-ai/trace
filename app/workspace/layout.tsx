import Trace from "@/components/trace-workspace";
export const dynamic = "force-dynamic";
export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Trace>{children}</Trace>;
}
