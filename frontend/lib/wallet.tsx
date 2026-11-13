"use client";

import "@near-wallet-selector/modal-ui/styles.css";

import { actionCreators } from "@near-js/transactions";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { Buffer } from "buffer";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { CONTRACT_ID, NETWORK } from "./config";
import { parseNear } from "./near";

export interface SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}

interface WalletState {
  ready: boolean;
  accountId: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Call a method on the Hivemind contract. `depositNear` is a decimal string, e.g. "0.1". */
  call: (method: string, args?: object, depositNear?: string, gasTgas?: number) => Promise<unknown>;
  signMessage: (p: { message: string; recipient: string; nonce: string; callbackUrl?: string }) => Promise<SignedMessage | void>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const s = await setupWalletSelector({
        network: NETWORK,
        modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet()],
      });
      const m = setupModal(s, { contractId: CONTRACT_ID });
      const active = (st: ReturnType<typeof s.store.getState>) => st.accounts.find((a) => a.active)?.accountId ?? null;
      setAccountId(active(s.store.getState()));
      const sub = s.store.observable.subscribe((st) => setAccountId(active(st)));
      unsubscribe = () => sub.unsubscribe();
      setSelector(s);
      setModal(m);
    })();
    return () => unsubscribe?.();
  }, []);

  const signIn = useCallback(() => modal?.show(), [modal]);

  const signOut = useCallback(async () => {
    if (!selector) return;
    const wallet = await selector.wallet();
    await wallet.signOut();
  }, [selector]);

  const call = useCallback(
    async (method: string, args: object = {}, depositNear = "0", gasTgas = 100) => {
      if (!selector) throw new Error("Wallet not ready");
      const wallet = await selector.wallet();
      return wallet.signAndSendTransaction({
        receiverId: CONTRACT_ID,
        actions: [actionCreators.functionCall(method, args, BigInt(gasTgas) * 10n ** 12n, parseNear(depositNear))],
      });
    },
    [selector],
  );

  const signMessage = useCallback(
    async (p: { message: string; recipient: string; nonce: string; callbackUrl?: string }) => {
      if (!selector) throw new Error("Wallet not ready");
      const wallet = await selector.wallet();
      if (!wallet.signMessage) throw new Error("This wallet cannot sign messages; try Meteor or MyNearWallet");
      return wallet.signMessage({
        message: p.message,
        recipient: p.recipient,
        nonce: Buffer.from(p.nonce, "base64"),
        callbackUrl: p.callbackUrl,
      });
    },
    [selector],
  );

  const value = useMemo(
    () => ({ ready: !!selector, accountId, signIn, signOut, call, signMessage }),
    [selector, accountId, signIn, signOut, call, signMessage],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside WalletProvider");
  return v;
}
