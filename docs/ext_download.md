# ext_download: Shareable Download Link Implementation

**Identifier:** `ext_download`  
**Feature:** Auto-connect + auto-download via URL params (peer, fileId, fileName)

---

## URL Format

```
https://yadavshashankr.github.io/one-host-develop/?peer=PEER_ID&fileId=FILE_ID&fileName=FILE_NAME
```

- `peer` (required): Sender's peer ID
- `fileId` (required): File identifier
- `fileName` (optional): File name for display/fallback; URL-encode if special chars

---

## Implementation Plan Summary

### 1. Module-level state (`script.js`)
```javascript
let pendingAutoDownload = null;  // { peerId, fileId, fileName }
```

### 2. Extend `checkUrlForPeerId()` (~line 529)
- Parse `peer`, `fileId`, `fileName` from URLSearchParams
- If `peer` + `fileId` exist, set `pendingAutoDownload = { peerId, fileId, fileName }`
- Auto-connect as today
- Track `download_link_opened` analytics when fileId present

### 3. In `setupConnectionHandlers` → `conn.on('open')` (~line 926)
- If `pendingAutoDownload && pendingAutoDownload.peerId === conn.peer`, send:
  ```javascript
  conn.send({ type: 'request-file-info', fileId, fileName });
  ```

### 4. Add handler for `request-file-info` (in `conn.on('data')` switch)
- Sender looks up file in `sentFileInfoMap` / fileGroups.sent
- If found, sends `file-info` back

### 5. Extend `file-info` handler (~line 1104)
- When file-info received, if it matches `pendingAutoDownload.fileId` and `pendingAutoDownload.peerId`, call `requestAndDownloadBlob(fileInfo)` and clear `pendingAutoDownload`

### 6. Add "Copy download link" button in `createFileListItem` (~line 4804)
- Only for `type === 'received'`
- Builds URL: `${baseUrl}?peer=${peer}&fileId=${id}&fileName=${name}`
- Copies to clipboard

### 7. Timeout / cleanup
- Clear `pendingAutoDownload` after ~30s if no matching file-info arrives
- Handle peer offline, file no longer available

---

## Files to Modify

| File       | Changes |
|-----------|---------|
| `script.js` | All changes above |

---

## Edge Cases

- Peer offline → connection fails, no auto-download
- File no longer available → sender doesn't send file-info, timeout clears
- Multiple files → only one file per URL for now
- Already connected → request-file-info sent when conn opens for that peer
