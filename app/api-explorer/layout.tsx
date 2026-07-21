import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ClickHouse — API Explorer",
  description: "Interactive REST API explorer for the ClickHouse Dashboard.",
};

export default function ApiExplorerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
