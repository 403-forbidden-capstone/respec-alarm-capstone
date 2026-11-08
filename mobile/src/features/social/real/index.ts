// ② 친구 · 그룹 · 공유 실데이터 구현 — api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌 (P6-4, 본보기: features/alarm/real.ts)
//   읽기 실패는 DB 원문 그대로 던지고(화면은 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
export {
  acceptFriend,
  cancelFriendRequest,
  declineFriend,
  listFriendRequests,
  listFriends,
  listSentRequests,
  myFriendLink,
  openFriendLink,
  removeFriend,
  searchByHandle,
  searchPeople,
  searchRelatedByName,
  sendFriendRequest,
} from './friends';
export { blockUser, listBlocks, submitReport, unblockUser } from './blocks';
export {
  acceptGroupInvite,
  createGroup,
  declineGroupInvite,
  getGroup,
  getGroupCode,
  getGroupSummary,
  inviteToGroup,
  joinGroup,
  leaveGroup,
  listGroupInvites,
  listGroups,
  listInvitableFriends,
  previewGroupByCode,
  regenerateInviteCode,
  removeGroupMember,
  renameGroup,
  setGroupNotificationsOff,
  setWakeShareOptIn,
} from './groups';
export { getFriendGrant, getReceived, getRelation, getShareSettings, listRelations, saveShareSettings } from './sharing';
export { getSharedAlarms, getShareLog, setSharedAlarmEnabled, shiftSharedAlarm } from './sharedAlarms';
export { getMemberWake, sendWakePing } from './wake';
