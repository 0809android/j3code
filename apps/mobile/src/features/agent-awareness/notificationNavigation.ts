import * as Notifications from "expo-notifications";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { openK3RelayNotificationData } from "./k3relayNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

let deepLinkOnScreen: string | null = null;

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  deepLinkOnScreen = threadDeepLinkOnScreen(pathname);
  setAndroidThreadOnScreen(deepLinkOnScreen);
}

/**
 * App-lifetime notification routing: foreground presentation suppresses the
 * thread already on screen, and taps (including the cold-start tap) open the
 * notification's deep link through `navigate`.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen)),
  });

  const handleResponse = (response: Notifications.NotificationResponse): void => {
    const data = response.notification.request.content.data as Record<string, unknown> | null;
    if (data && typeof data.k3 === "string" && typeof data.environmentId !== "string") {
      // The extension could not open this K3 relay notification; the app opens it instead.
      void openK3RelayNotificationData(data).then((opened) => {
        if (opened?.ok && opened.payload.thread !== undefined) {
          navigate(
            `/threads/${encodeURIComponent(opened.payload.env)}/${encodeURIComponent(opened.payload.thread)}`,
          );
        }
      });
      return;
    }
    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
