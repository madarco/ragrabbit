"use client";
import type * as React from "react";
import { Toaster } from "@repo/design/shadcn/toaster";
import { SWRConfig } from "swr";
import { ConfigProvider } from "@repo/design/components/providers/config-provider";
import { headerMenu } from "../settings/menu";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      value={{
        headerMenu,
      }}
    >
      <SWRConfig
        value={{
          fetcher: (resource, init) => fetch(resource, init).then((res) => res.json()),
        }}
      >
        {children}
      </SWRConfig>
      <Toaster />
    </ConfigProvider>
  );
}
