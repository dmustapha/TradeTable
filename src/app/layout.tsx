import type {Metadata} from "next";
import {DM_Serif_Display, IBM_Plex_Mono} from "next/font/google";
import "./globals.css";

const display = DM_Serif_Display({subsets: ["latin"], weight: "400", variable: "--font-display"});
const mono = IBM_Plex_Mono({subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono"});

export const metadata: Metadata = {
  title: "TradeTable — Three-way collectible settlement",
  description: "Six assets enter custody. Three selected assets settle atomically. Three return.",
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html className={`${display.variable} ${mono.variable}`} lang="en"><body>{children}</body></html>;
}
