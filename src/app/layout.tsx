import type {Metadata} from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TradeTable — Three-way collectible settlement",
  description: "Six assets enter custody. Three selected assets settle atomically. Three return.",
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
