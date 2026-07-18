import type { ReactNode } from "react";

export const metadata = {
  title: "Disruption Rescue",
  description: "One cancelled flight becomes one phone call — rebooked and reimbursed.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#0b0f17",
          color: "#e8edf5",
        }}
      >
        {children}
      </body>
    </html>
  );
}
