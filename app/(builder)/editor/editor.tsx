"use client";

import { getSupabaseClient } from "@/app/supabase-client";
import { registerCustomBlocks, registerFonts } from "@gnr8/chai-renderer";
import { ChaiWebsiteBuilder, defaultChaiLibrary } from "@chaibuilder/next";
import { registerChaiLibrary } from "@chaibuilder/next/runtime-client";
import type { ChaiLoggedInUser } from "@chaibuilder/next/types";
import { useCallback, useEffect, useState } from "react";
import { LoginScreen } from "./login";

registerCustomBlocks();
registerChaiLibrary("chai-library", defaultChaiLibrary());
registerFonts();

const supabase = getSupabaseClient();

const mapSessionUserToChaiUser = (sessionUser: any): ChaiLoggedInUser =>
  ({
    id: sessionUser.id,
    email: sessionUser.email,
    name:
      sessionUser.user_metadata?.name ||
      sessionUser.user_metadata?.full_name ||
      sessionUser.email,
    role: sessionUser.user_metadata?.role || "admin",
  }) as ChaiLoggedInUser;

export default function Editor() {
  const [isLoggedIn, setIsLoggedIn] = useState<null | boolean>(null);
  const [user, setUser] = useState<ChaiLoggedInUser | null>(null);

  useEffect(() => {
    const checkInitialSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.user) {
        setUser(mapSessionUserToChaiUser(session.user));
        setIsLoggedIn(true);
      } else {
        setIsLoggedIn(false);
      }
    };

    checkInitialSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (user?.id && session?.user) {
        return;
      }

      if (session?.user) {
        setUser(mapSessionUserToChaiUser(session.user));
        setIsLoggedIn(true);
      } else {
        setUser(null);
        setIsLoggedIn(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [user?.id]);

  const handleLogout = useCallback(async (reason?: string) => {
    await supabase.auth.signOut();
    if (reason) {
      window.location.href = `/editor?${reason.toLowerCase()}=true`;
    } else {
      window.location.reload();
    }
  }, []);

  const getAccessToken = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token as string;
  }, []);

  const getPreviewUrl = useCallback((slug: string) => `/api/preview?slug=${slug}`, []);
  const getLiveUrl = useCallback(
    (slug: string) => `/api/preview?disable=true&slug=${slug}`,
    [],
  );

  if (isLoggedIn === null) return null;
  if (!isLoggedIn) return <LoginScreen />;

  return (
    <ChaiWebsiteBuilder
      flags={{ dragAndDrop: true, ai: true }}
      currentUser={user}
      autoSave
      autoSaveActionsCount={5}
      getAccessToken={getAccessToken}
      apiUrl="api"
      getPreviewUrl={getPreviewUrl}
      getLiveUrl={getLiveUrl}
      websocket={supabase}
      onLogout={handleLogout}
    />
  );
}