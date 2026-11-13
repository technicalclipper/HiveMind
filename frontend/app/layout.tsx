import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";

import { Nav } from "@/components/nav";
import { Ticker } from "@/components/ticker";
import { WalletProvider } from "@/lib/wallet";

import "./globals.css";

const grotesk = Space_Grotesk({ variable: "--font-grotesk", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Hivemind",
  description: "A community-owned AI model on NEAR. Train together, own together, earn together.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${grotesk.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen">
        <div className="backdrop" />
        <WalletProvider>
          <Nav />
          <Ticker />
          <main className="mx-auto w-full max-w-7xl px-4 pb-24 pt-10 sm:px-6">{children}</main>
          <footer className="border-t border-white/5 py-8 text-center text-xs text-muted">
            Hivemind · NEAR testnet · contracts{" "}
            <a className="font-mono hover:text-text" href="https://testnet.nearblocks.io/address/core.hivemind-ai.testnet" target="_blank" rel="noreferrer">
              core.hivemind-ai.testnet
            </a>{" "}
            ·{" "}
            <a className="font-mono hover:text-text" href="https://testnet.nearblocks.io/address/hive.hivemind-ai.testnet" target="_blank" rel="noreferrer">
              hive.hivemind-ai.testnet
            </a>{" "}
            · evaluator TEE simulated
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
