import { SessionInfo } from "./info";
import type { SessionInfo as SessionInfoType } from "./info";
import { Event as SessionEvent } from "./events";
import * as Lifecycle from "./lifecycle";
import * as Messages from "./messages";

export namespace Session {
  export const Info = SessionInfo;
  export type Info = SessionInfoType;

  export const Event = SessionEvent;
  export const create = Lifecycle.create;
  export const createChild = Lifecycle.createChild;
  export const get = Lifecycle.get;
  export const list = Lifecycle.list;
  export const listChildren = Lifecycle.listChildren;
  export const getWorkerMeta = Lifecycle.getWorkerMeta;
  export const updateWorkerMeta = Lifecycle.updateWorkerMeta;
  export const update = Lifecycle.update;
  export const remove = Lifecycle.remove;
  export const sweepExpired = Lifecycle.sweepExpired;
  export const addMessage = Messages.addMessage;
  export const updateMessageStatus = Messages.updateMessageStatus;
  export const getMessages = Messages.getMessages;
  export const listMessagesPage = Messages.listMessagesPage;
  export const hydrateMessages = Messages.hydrateMessages;
  export const addPart = Messages.addPart;
  export const getParts = Messages.getParts;
  export const suspend = Lifecycle.suspend;
  export const resume = Messages.resume;
  export const abandon = Lifecycle.abandon;
}
