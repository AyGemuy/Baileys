import {
  proto
} from "../../WAProto/index.js";
import {
  Boom
} from "@hapi/boom";
import {
  WAMessageStubType
} from "../Types/index.js";
import {
  getContentType,
  normalizeMessageContent
} from "./messages.js";
import {
  areJidsSameUser,
  isHostedLidUser,
  isHostedPnUser,
  isJidBroadcast,
  isJidStatusBroadcast,
  isLidUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser
} from "../WABinary/index.js";
import {
  aesDecryptGCM,
  hmacSign
} from "./crypto.js";
import {
  createDecipheriv,
  createHmac
} from "crypto";
import {
  getKeyAuthor,
  toNumber
} from "./generics.js";
import {
  downloadAndProcessHistorySyncNotification
} from "./history.js";
import {
  buildMergedTcTokenIndexWrite,
  resolveTcTokenJid
} from "./tc-token-utils.js";
const REAL_MSG_STUB_TYPES = new Set([WAMessageStubType.CALL_MISSED_GROUP_VIDEO, WAMessageStubType.CALL_MISSED_GROUP_VOICE, WAMessageStubType.CALL_MISSED_VIDEO, WAMessageStubType.CALL_MISSED_VOICE]);
const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD]);
const SELF_ONLY_PROTOCOL_TYPES = new Set([proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION, proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE, proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC, proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE]);
async function storeTcTokensFromHistorySync(chats, signalRepository, keyStore, logger) {
  const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
  const candidates = [];
  for (const chat of chats) {
    const ts = chat.tcTokenTimestamp ? toNumber(chat.tcTokenTimestamp) : 0;
    if (!chat.tcToken?.length || ts <= 0) continue;
    const jid = jidNormalizedUser(chat.id);
    const storageJid = await resolveTcTokenJid(jid, getLIDForPN);
    candidates.push({
      storageJid: storageJid,
      token: Buffer.from(chat.tcToken),
      ts: ts,
      senderTs: chat.tcTokenSenderTimestamp ? toNumber(chat.tcTokenSenderTimestamp) : undefined
    });
  }
  if (!candidates.length) return;
  const existing = await keyStore.get("tctoken", candidates.map(c => c.storageJid));
  const entries = {};
  for (const c of candidates) {
    const existingTs = existing[c.storageJid]?.timestamp ? Number(existing[c.storageJid].timestamp) : 0;
    if (existingTs > 0 && existingTs >= c.ts) continue;
    entries[c.storageJid] = {
      ...existing[c.storageJid],
      token: c.token,
      timestamp: String(c.ts),
      ...c.senderTs !== undefined ? {
        senderTimestamp: c.senderTs
      } : {}
    };
  }
  if (!Object.keys(entries).length) return;
  try {
    const indexWrite = await buildMergedTcTokenIndexWrite(keyStore, Object.keys(entries));
    await keyStore.set({
      tctoken: {
        ...entries,
        ...indexWrite
      }
    });
  } catch (err) {
    logger?.warn({
      err: err
    }, "failed to store tctokens from history sync");
  }
}
export const cleanMessage = (message, meId, meLid) => {
  if (isHostedPnUser(message.key.remoteJid) || isHostedLidUser(message.key.remoteJid)) {
    message.key.remoteJid = jidEncode(jidDecode(message.key?.remoteJid)?.user, isHostedPnUser(message.key.remoteJid) ? "s.whatsapp.net" : "lid");
  } else {
    message.key.remoteJid = jidNormalizedUser(message.key.remoteJid);
  }
  if (isHostedPnUser(message.key.participant) || isHostedLidUser(message.key.participant)) {
    message.key.participant = jidEncode(jidDecode(message.key.participant)?.user, isHostedPnUser(message.key.participant) ? "s.whatsapp.net" : "lid");
  } else {
    message.key.participant = jidNormalizedUser(message.key.participant);
  }
  let content = normalizeMessageContent(message.message);
  if (content?.reactionMessage) normaliseKey(content.reactionMessage.key);
  if (content?.pollUpdateMessage) normaliseKey(content.pollUpdateMessage.pollCreationMessageKey);
  if (content?.protocolMessage?.key) normaliseKey(content.protocolMessage.key);

  function normaliseKey(msgKey) {
    if (message.key.fromMe) return;
    msgKey.fromMe = !msgKey.fromMe ? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId) || areJidsSameUser(msgKey.participant || msgKey.remoteJid, meLid) : false;
    msgKey.remoteJid = message.key.remoteJid;
    msgKey.participant = msgKey.participant || message.key.participant;
  }
};
export const isRealMessage = message => {
  const normalizedContent = normalizeMessageContent(message.message);
  return (!!normalizedContent || REAL_MSG_STUB_TYPES.has(message.messageStubType) || REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType)) && !!getContentType(normalizedContent) && !normalizedContent?.protocolMessage && !normalizedContent?.reactionMessage && !normalizedContent?.pollUpdateMessage;
};
export const shouldIncrementChatUnread = message => !message.key.fromMe && !message.messageStubType;
export const getChatId = ({
  remoteJid,
  participant,
  fromMe
}) => {
  if (!remoteJid) throw new Boom("Cannot derive chat id: message key is missing remoteJid", {
    data: {
      remoteJid: remoteJid,
      participant: participant,
      fromMe: fromMe
    }
  });
  if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
    if (!participant) throw new Boom("Cannot derive chat id: broadcast message key is missing participant", {
      data: {
        remoteJid: remoteJid,
        fromMe: fromMe
      }
    });
    return participant;
  }
  return remoteJid;
};
export function decryptMessageEdit({
  encPayload,
  encIv
}, {
  origMsgId,
  origMsgSenderJid,
  editorJid,
  msgEncKey
}) {
  if (typeof msgEncKey === "string") {
    msgEncKey = Buffer.from(msgEncKey, "base64");
  }
  if (!encPayload || !encIv || !msgEncKey) {
    throw new Error("Missing data required to decrypt secretEncryptedMessage");
  }
  const toBinary = txt => Buffer.from(String(txt));
  const sign = Buffer.concat([toBinary(origMsgId), toBinary(origMsgSenderJid), toBinary(editorJid), toBinary("Message Edit"), new Uint8Array([1])]);
  const key0 = hmacSign(msgEncKey, new Uint8Array(32), "sha256");
  const decKey = hmacSign(sign, key0, "sha256");
  const decrypted = aesDecryptGCM(encPayload, decKey, encIv, new Uint8Array(0));
  return proto.Message.decode(decrypted);
}
const toBufferSafe = b => {
  if (!b) return Buffer.alloc(0);
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (typeof b === "string") {
    if (b.length === 64 && /^[0-9a-fA-F]+$/.test(b)) return Buffer.from(b, "hex");
    return Buffer.from(b, "base64");
  }
  if (b && typeof b === "object" && Array.isArray(b.data)) return Buffer.from(b.data);
  if (Array.isArray(b)) return Buffer.from(b);
  return Buffer.from(b);
};
export function decryptPollVote(vote, {
  pollCreatorJids = [],
  pollMsgId,
  pollEncKey,
  voterJids = []
}) {
  const encPayload = toBufferSafe(vote?.encPayload);
  const encIv = toBufferSafe(vote?.encIv);
  const secretBuf = toBufferSafe(pollEncKey);
  if (!encPayload.length || !encIv.length || !secretBuf.length || encPayload.length < 16) {
    return null;
  }
  const toBinary = txt => Buffer.from(String(txt), "utf-8");
  const cleanJid = j => typeof j === "string" && j.trim() !== "" && !j.endsWith("@g.us");
  const creators = [...new Set(pollCreatorJids.filter(cleanJid).map(jidNormalizedUser))];
  const voters = [...new Set(voterJids.filter(cleanJid).map(jidNormalizedUser))];
  for (const creator of creators) {
    for (const voter of voters) {
      try {
        const sign = Buffer.concat([toBinary(pollMsgId), toBinary(creator), toBinary(voter), toBinary("Poll Vote"), new Uint8Array([1])]);
        const key0 = hmacSign(secretBuf, new Uint8Array(32), "sha256");
        const decKey = hmacSign(sign, key0, "sha256");
        const aad = toBinary(`${pollMsgId}\u0000${voter}`);
        const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
        return proto.Message.PollVoteMessage.decode(decrypted);
      } catch {}
      try {
        const signLegacy = Buffer.concat([toBinary(pollMsgId), toBinary(creator), toBinary(voter), toBinary("Poll Vote")]);
        const decKey = hmacSign(secretBuf, signLegacy, "sha256");
        const decrypted = aesDecryptGCM(encPayload, decKey, encIv, Buffer.alloc(0));
        return proto.Message.PollVoteMessage.decode(decrypted);
      } catch {}
    }
  }
  return null;
}
export function decryptEventResponse({
  encPayload,
  encIv
}, {
  eventCreatorJid,
  eventMsgId,
  eventEncKey,
  responderJid
}) {
  const toBinary = txt => Buffer.from(txt);
  const sign = Buffer.concat([toBinary(eventMsgId), toBinary(eventCreatorJid), toBinary(responderJid), toBinary("Event Response"), new Uint8Array([1])]);
  const decKey = hmacSign(sign, hmacSign(eventEncKey, new Uint8Array(32), "sha256"), "sha256");
  return proto.Message.EventResponseMessage.decode(aesDecryptGCM(encPayload, decKey, encIv, toBinary(`${eventMsgId}\u0000${responderJid}`)));
}
export const processMessage = async (message, {
  shouldProcessHistoryMsg,
  placeholderResendCache,
  ev,
  creds,
  signalRepository,
  keyStore,
  logger,
  options,
  getMessage
}) => {
  const meId = creds.me.id;
  const meLid = creds?.me?.lid;
  const {
    accountSettings
  } = creds;
  const chat = {
    id: jidNormalizedUser(getChatId(message.key))
  };
  let content = normalizeMessageContent(message.message);
  const secretEnc = content?.secretEncryptedMessage;
  if (secretEnc?.encPayload && secretEnc?.encIv && secretEnc?.targetMessageKey?.id) {
    const targetKey = secretEnc.targetMessageKey;
    try {
      const origMsg = await getMessage({
        ...targetKey,
        remoteJid: message.key.remoteJid,
        fromMe: message.key.fromMe,
        participant: message.key.participant
      });
      let msgEncKey = origMsg?.message?.messageContextInfo?.messageSecret || origMsg?.messageContextInfo?.messageSecret || origMsg?.rawMessage?.messageContextInfo?.messageSecret;
      if (typeof msgEncKey === "string") {
        msgEncKey = Buffer.from(msgEncKey, "base64");
      }
      if (msgEncKey) {
        const meIdNormalised = jidNormalizedUser(creds.me.id);
        const meLidNormalised = creds?.me?.lid ? jidNormalizedUser(creds.me.lid) : undefined;
        const candidates = [...message.key.fromMe ? [meIdNormalised, meLidNormalised] : [message.key.participant || message.key.remoteJid, message.key.participantAlt || message.key.remoteJidAlt], targetKey.remoteJid, targetKey.participant].filter(Boolean).map(jidNormalizedUser);
        let decoded = null;
        for (const authorJid of candidates) {
          try {
            decoded = decryptMessageEdit(secretEnc, {
              origMsgId: targetKey.id,
              origMsgSenderJid: authorJid,
              editorJid: authorJid,
              msgEncKey: msgEncKey
            });
            if (decoded) break;
          } catch (_) {}
        }
        if (decoded) {
          message.message = proto.Message.fromObject({
            protocolMessage: {
              key: targetKey,
              type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
              editedMessage: decoded
            }
          });
          content = normalizeMessageContent(message.message);
        }
      }
    } catch (err) {
      logger?.warn({
        err: err,
        targetKey: targetKey
      }, "failed to decrypt secretEncryptedMessage edit");
    }
  }
  const isRealMsg = isRealMessage(message);
  if (isRealMsg) {
    chat.messages = [{
      message: message
    }];
    chat.conversationTimestamp = toNumber(message.messageTimestamp);
    if (shouldIncrementChatUnread(message)) chat.unreadCount = (chat.unreadCount || 0) + 1;
  }
  content = normalizeMessageContent(message.message);
  if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
    chat.archived = false;
    chat.readOnly = false;
  }
  const protocolMsg = content?.protocolMessage;
  if (protocolMsg) {
    if (protocolMsg.type !== null && protocolMsg.type !== undefined && SELF_ONLY_PROTOCOL_TYPES.has(protocolMsg.type) && !message.key.fromMe) {
      logger?.warn({
        msgId: message.key.id,
        type: protocolMsg.type,
        from: message.key.participant || message.key.remoteJid
      }, "dropping spoofed self-only protocolMessage from non-self origin");
      return;
    }
    switch (protocolMsg.type) {
      case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION: {
        const histNotification = protocolMsg.historySyncNotification;
        const isLatest = !creds.processedHistoryMessages?.length;
        if (shouldProcessHistoryMsg) {
          if (histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
            ev.emit("creds.update", {
              processedHistoryMessages: [...creds.processedHistoryMessages || [], {
                key: message.key,
                messageTimestamp: message.messageTimestamp
              }]
            });
          }
          const data = await downloadAndProcessHistorySyncNotification(histNotification, options, logger);
          if (data.lidPnMappings?.length) {
            await signalRepository.lidMapping.storeLIDPNMappings(data.lidPnMappings).catch(err => logger?.warn({
              err: err
            }, "failed to store LID-PN mappings from history sync"));
          }
          await storeTcTokensFromHistorySync(data.chats, signalRepository, keyStore, logger);
          ev.emit("messaging-history.set", {
            ...data,
            isLatest: histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ? isLatest : undefined,
            chunkOrder: histNotification.chunkOrder,
            peerDataRequestSessionId: histNotification.peerDataRequestSessionId
          });
        }
        break;
      }
      case proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE: {
        const keys = protocolMsg.appStateSyncKeyShare.keys;
        if (keys?.length) {
          let newAppStateSyncKeyId = "";
          await keyStore.transaction(async () => {
            const newKeys = [];
            for (const {
                keyData,
                keyId
              }
              of keys) {
              const strKeyId = Buffer.from(keyId.keyId).toString("base64");
              newKeys.push(strKeyId);
              await keyStore.set({
                "app-state-sync-key": {
                  [strKeyId]: keyData
                }
              });
              newAppStateSyncKeyId = strKeyId;
            }
          }, meId);
          ev.emit("creds.update", {
            myAppStateKeyId: newAppStateSyncKeyId
          });
        }
        break;
      }
      case proto.Message.ProtocolMessage.Type.REVOKE: {
        ev.emit("messages.update", [{
          key: {
            ...message.key,
            id: protocolMsg.key.id
          },
          update: {
            message: null,
            messageStubType: WAMessageStubType.REVOKE,
            key: message.key
          }
        }]);
        break;
      }
      case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING: {
        Object.assign(chat, {
          ephemeralSettingTimestamp: toNumber(message.messageTimestamp),
          ephemeralExpiration: protocolMsg.ephemeralExpiration || null
        });
        break;
      }
      case proto.Message.ProtocolMessage.Type.MESSAGE_EDIT: {
        ev.emit("messages.update", [{
          key: {
            ...message.key,
            id: protocolMsg.key?.id
          },
          update: {
            message: {
              editedMessage: {
                message: protocolMsg.editedMessage
              }
            },
            messageTimestamp: protocolMsg.timestampMs ? Math.floor(toNumber(protocolMsg.timestampMs) / 1e3) : message.messageTimestamp
          }
        }]);
        break;
      }
      case proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE: {
        const labelAssociationMsg = protocolMsg.memberLabel;
        if (labelAssociationMsg?.label) {
          ev.emit("group.member-tag.update", {
            groupId: chat.id,
            label: labelAssociationMsg.label,
            participant: message.key.participant,
            participantAlt: message.key.participantAlt,
            messageTimestamp: Number(message.messageTimestamp)
          });
        }
        break;
      }
      case proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: {
        const response = protocolMsg.peerDataOperationRequestResponseMessage;
        if (!response) break;
        for (const result of response.peerDataOperationResult || []) {
          const retryResponse = result?.placeholderMessageResendResponse;
          if (!retryResponse?.webMessageInfoBytes) continue;
          try {
            const webMessageInfo = proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes);
            const msgId = webMessageInfo.key?.id;
            const cachedData = msgId ? await placeholderResendCache?.get(msgId) : undefined;
            if (msgId) await placeholderResendCache?.del(msgId);
            let finalMsg;
            if (cachedData && typeof cachedData === "object") {
              cachedData.message = webMessageInfo.message;
              if (webMessageInfo.messageTimestamp) cachedData.messageTimestamp = webMessageInfo.messageTimestamp;
              finalMsg = cachedData;
            } else {
              finalMsg = webMessageInfo;
            }
            ev.emit("messages.upsert", {
              messages: [finalMsg],
              type: "notify",
              requestId: response.stanzaId
            });
          } catch (err) {
            logger?.warn({
              err: err,
              stanzaId: response.stanzaId
            }, "failed to decode placeholder resend response");
          }
        }
        break;
      }
      case proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC: {
        const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload;
        const {
          pnToLidMappings,
          chatDbMigrationTimestamp
        } = proto.LIDMigrationMappingSyncPayload.decode(encodedPayload);
        const pairs = [];
        for (const {
            pn,
            latestLid,
            assignedLid
          }
          of pnToLidMappings) {
          pairs.push({
            lid: `${latestLid || assignedLid}@lid`,
            pn: `${pn}@s.whatsapp.net`
          });
        }
        await signalRepository.lidMapping.storeLIDPNMappings(pairs);
        for (const {
            pn,
            lid
          }
          of pairs) await signalRepository.migrateSession(pn, lid);
        break;
      }
      case proto.Message.ProtocolMessage.Type.STOP_GENERATION_MESSAGE: {
        ev.emit("messages.update", [{
          key: {
            remoteJid: message.key.remoteJid,
            id: protocolMsg.key?.id
          },
          update: {
            generationStopped: true
          }
        }]);
        break;
      }
      case proto.Message.ProtocolMessage.Type.CHAT_THEME_SETTING: {
        ev.emit("chats.update", [{
          id: message.key.remoteJid,
          theme: protocolMsg.chatThemeSetting
        }]);
        break;
      }
      case proto.Message.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION: {
        ev.emit("contacts.update", [{
          id: message.key.remoteJid,
          verified: protocolMsg.markAsVerifiedAction?.verified
        }]);
        break;
      }
      case proto.Message.ProtocolMessage.Type.MESSAGE_UNSCHEDULE: {
        ev.emit("messages.update", [{
          key: {
            remoteJid: message.key.remoteJid,
            id: protocolMsg.key?.id
          },
          update: {
            messageStubType: WAMessageStubType.SCHEDULED_MESSAGE_CREATED,
            scheduled: false
          }
        }]);
        break;
      }
    }
  } else if (content?.reactionMessage) {
    ev.emit("messages.reaction", [{
      reaction: {
        ...content.reactionMessage,
        key: message.key
      },
      key: content.reactionMessage?.key
    }]);
  } else if (content?.pollUpdateMessage) {
    const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey;
    const pollMsg = await getMessage(creationMsgKey);
    if (pollMsg) {
      try {
        const userJid = meLid ? jidNormalizedUser(meLid) : jidNormalizedUser(meId);
        const innerMsg = normalizeMessageContent(pollMsg.message || pollMsg);
        const messageContextInfo = pollMsg.messageContextInfo || innerMsg?.messageContextInfo || pollMsg.message?.messageContextInfo || innerMsg?.pollCreationMessage?.messageContextInfo || innerMsg?.pollCreationMessageV2?.messageContextInfo || innerMsg?.pollCreationMessageV3?.messageContextInfo;
        const pollEncKey = messageContextInfo?.messageSecret;
        if (!pollEncKey) {
          logger?.warn({
            creationMsgKey: creationMsgKey
          }, "poll vote: missing messageSecret for decryption");
          return;
        }
        const creatorCandidates = new Set();
        const pollCreatorAuthor = getKeyAuthor(creationMsgKey, userJid);
        if (pollCreatorAuthor) creatorCandidates.add(pollCreatorAuthor);
        if (pollMsg.key?.participant) creatorCandidates.add(pollMsg.key.participant);
        if (userJid) creatorCandidates.add(userJid);
        if (meId) creatorCandidates.add(jidNormalizedUser(meId));
        const voterCandidates = new Set();
        const voterAuthor = getKeyAuthor(message.key, userJid);
        if (voterAuthor) voterCandidates.add(voterAuthor);
        const resolveLids = async set => {
          const arr = [...set];
          for (const id of arr) {
            if (typeof id !== "string") continue;
            if (!id.endsWith("@lid") && typeof signalRepository?.lidMapping?.getLIDForPN === "function") {
              const lid = await signalRepository.lidMapping.getLIDForPN(id).catch(() => null);
              if (lid) set.add(lid);
            } else if (id.endsWith("@lid") && typeof signalRepository?.lidMapping?.getPNForLID === "function") {
              const pn = await signalRepository.lidMapping.getPNForLID(id).catch(() => null);
              if (pn) set.add(pn);
            }
          }
        };
        await resolveLids(creatorCandidates);
        await resolveLids(voterCandidates);
        const voteMsg = decryptPollVote(content.pollUpdateMessage.vote, {
          pollEncKey: pollEncKey,
          pollCreatorJids: [...creatorCandidates],
          pollMsgId: creationMsgKey.id,
          voterJids: [...voterCandidates]
        });
        if (voteMsg) {
          ev.emit("messages.update", [{
            key: creationMsgKey,
            update: {
              pollUpdates: [{
                pollUpdateMessageKey: message.key,
                vote: voteMsg,
                senderTimestampMs: toNumber(content.pollUpdateMessage.senderTimestampMs)
              }]
            }
          }]);
        } else {
          logger?.warn({
            creationMsgKey: creationMsgKey
          }, "failed to decrypt poll vote: tag mismatch");
        }
      } catch (err) {
        logger?.warn({
          err: err?.message || err,
          creationMsgKey: creationMsgKey
        }, "failed to decrypt poll vote safely");
      }
    } else {
      logger?.warn({
        creationMsgKey: creationMsgKey
      }, "poll creation message not found, cannot decrypt update");
    }
  } else if (content?.encEventResponseMessage) {
    const encEventResponse = content.encEventResponseMessage;
    const creationMsgKey = encEventResponse.eventCreationMessageKey;
    const eventMsg = await getMessage(creationMsgKey);
    if (eventMsg) {
      try {
        const meIdNormalised = jidNormalizedUser(meId);
        const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid;
        const eventCreatorPn = isLidUser(eventCreatorKey) ? await signalRepository.lidMapping.getPNForLID(eventCreatorKey) : eventCreatorKey;
        const eventCreatorJid = getKeyAuthor({
          remoteJid: jidNormalizedUser(eventCreatorPn),
          fromMe: meIdNormalised === eventCreatorPn
        }, meIdNormalised);
        const responderJid = getKeyAuthor(message.key, meIdNormalised);
        const eventEncKey = eventMsg?.messageContextInfo?.messageSecret;
        if (!eventEncKey) {
          logger?.warn({
            creationMsgKey: creationMsgKey
          }, "event response: missing messageSecret for decryption");
        } else {
          const responseMsg = decryptEventResponse(encEventResponse, {
            eventEncKey: eventEncKey,
            eventCreatorJid: eventCreatorJid,
            eventMsgId: creationMsgKey.id,
            responderJid: responderJid
          });
          ev.emit("messages.update", [{
            key: creationMsgKey,
            update: {
              eventResponses: [{
                eventResponseMessageKey: message.key,
                senderTimestampMs: responseMsg.timestampMs,
                response: responseMsg
              }]
            }
          }]);
        }
      } catch (err) {
        logger?.warn({
          err: err,
          creationMsgKey: creationMsgKey
        }, "failed to decrypt event response");
      }
    } else {
      logger?.warn({
        creationMsgKey: creationMsgKey
      }, "event creation message not found, cannot decrypt response");
    }
  } else if (message.messageStubType) {
    const jid = message.key?.remoteJid;
    let participants;
    const emitParticipantsUpdate = action => ev.emit("group-participants.update", {
      id: jid,
      author: message.key.participant,
      authorPn: message.key.participantAlt,
      authorUsername: message.key.participantUsername,
      participants: participants,
      action: action
    });
    const emitGroupUpdate = update => ev.emit("groups.update", [{
      id: jid,
      ...update,
      author: message.key.participant ?? undefined,
      authorPn: message.key.participantAlt,
      authorUsername: message.key.participantUsername
    }]);
    const emitGroupRequestJoin = (participant, action, method) => ev.emit("group.join-request", {
      id: jid,
      author: message.key.participant,
      authorPn: message.key.participantAlt,
      authorUsername: message.key.participantUsername,
      participant: participant.lid,
      participantPn: participant.pn,
      action: action,
      method: method
    });
    const participantsIncludesMe = () => participants.find(p => areJidsSameUser(meId, p.phoneNumber) || meLid && areJidsSameUser(meLid, p.phoneNumber));
    switch (message.messageStubType) {
      case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
        participants = message.messageStubParameters.map(a => JSON.parse(a)) || [];
        emitParticipantsUpdate("modify");
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
      case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
        participants = message.messageStubParameters.map(a => JSON.parse(a)) || [];
        emitParticipantsUpdate("remove");
        if (participantsIncludesMe()) chat.readOnly = true;
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_ADD:
      case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
      case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
        participants = message.messageStubParameters.map(a => JSON.parse(a)) || [];
        if (participantsIncludesMe()) chat.readOnly = false;
        emitParticipantsUpdate("add");
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
        participants = message.messageStubParameters.map(a => JSON.parse(a)) || [];
        emitParticipantsUpdate("demote");
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
        participants = message.messageStubParameters.map(a => JSON.parse(a)) || [];
        emitParticipantsUpdate("promote");
        break;
      case WAMessageStubType.GROUP_CHANGE_ANNOUNCE: {
        const announceValue = message.messageStubParameters?.[0];
        emitGroupUpdate({
          announce: announceValue === "true" || announceValue === "on"
        });
        break;
      }
      case WAMessageStubType.GROUP_CHANGE_RESTRICT: {
        const restrictValue = message.messageStubParameters?.[0];
        emitGroupUpdate({
          restrict: restrictValue === "true" || restrictValue === "on"
        });
        break;
      }
      case WAMessageStubType.GROUP_CHANGE_SUBJECT: {
        const name = message.messageStubParameters?.[0];
        chat.name = name;
        emitGroupUpdate({
          subject: name
        });
        break;
      }
      case WAMessageStubType.GROUP_CHANGE_DESCRIPTION: {
        const description = message.messageStubParameters?.[0];
        chat.description = description;
        emitGroupUpdate({
          desc: description
        });
        break;
      }
      case WAMessageStubType.GROUP_CHANGE_INVITE_LINK: {
        emitGroupUpdate({
          inviteCode: message.messageStubParameters?.[0]
        });
        break;
      }
      case WAMessageStubType.GROUP_MEMBER_ADD_MODE: {
        const memberAddValue = message.messageStubParameters?.[0];
        emitGroupUpdate({
          memberAddMode: memberAddValue === "all_member_add"
        });
        break;
      }
      case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE: {
        const approvalMode = message.messageStubParameters?.[0];
        emitGroupUpdate({
          joinApprovalMode: approvalMode === "on"
        });
        break;
      }
      case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD: {
        const participant = JSON.parse(message.messageStubParameters?.[0]);
        emitGroupRequestJoin(participant, message.messageStubParameters?.[1], message.messageStubParameters?.[2]);
        break;
      }
    }
  }
  if (Object.keys(chat).length > 1) ev.emit("chats.update", [chat]);
};
export default processMessage;