// 렌더러에서 호출 가능한 Git 함수 목록 (메인/프리로드 공용 화이트리스트)
module.exports = [
  // 기본
  'status', 'workingFilePair', 'commitFilePair', 'commit', 'lastCommitMessage', 'rollback', 'log', 'commitDetails',
  'branches', 'checkout', 'checkoutRemote', 'createBranch', 'deleteBranch', 'deleteRemoteBranch', 'renameBranch',
  'merge', 'mergePreview', 'rebase', 'cherryPick', 'revertCommit', 'reset', 'operation', 'remotes', 'addRemote', 'setRemoteUrl',
  'removeRemote', 'fetchAll', 'pull', 'push', 'outgoing', 'stashList', 'stashSave', 'stashApply', 'stashPop', 'stashDrop',
  'stashFiles', 'conflictInfo', 'resolveWithContent', 'resolveSide', 'createTag', 'deleteTag', 'config', 'setConfig',
  'addToGitignore', 'fileHunks',
  // 고급 (git-extra.js)
  'rebaseCommits', 'interactiveRebase', 'cherryPickMany', 'revertMany', 'blame', 'reflog', 'compareRefs', 'refFilePair',
  'bisectReset',
];
