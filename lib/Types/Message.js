import {
  proto
} from "../../WAProto/index.js";
export {
  proto as WAProto
};
export const WAMessageStubType = new Proxy({}, {
  get: (_, k) => proto.WebMessageInfo?.StubType?.[k]
});
export const WAMessageStatus = new Proxy({}, {
  get: (_, k) => proto.WebMessageInfo?.Status?.[k]
});
export const WAMessageAddressingMode = Object.freeze({
  PN: "pn",
  LID: "lid"
});
export const resolveStubType = stubType => proto.WebMessageInfo?.StubType?.[stubType] ?? `UNKNOWN_STUB_${stubType}`;