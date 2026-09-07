import { Brain, Inbox, MessageSquare, MessagesSquare, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import type { Place, Route } from "../state/store";

const ROUTE_ICON: Record<Route, ReactNode> = {
  sessions: <MessagesSquare />,
  inbox: <Inbox />,
  automations: <Workflow />,
  memory: <Brain />,
};

export function placeIcon(place: Place): ReactNode {
  return place.kind === "session" ? <MessageSquare /> : ROUTE_ICON[place.route];
}
