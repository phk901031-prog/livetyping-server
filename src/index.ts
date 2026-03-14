import { createServer } from 'http'
import { Server as SocketIOServer } from 'socket.io'

// ─── 타입 ────────────────────────────────────────────────────────────────────
type UserRole = '속기사1' | '속기사2'

interface Segment {
  index: number
  user: UserRole
  content: string
  status: 'typing' | 'completed'
}

// 미디어 상태: 방에서 현재 재생 중인 미디어 정보
// YouTube면 videoId만 기억, 로컬 파일이면 메타데이터만 기억 (파일 자체는 저장 안 함)
interface MediaState {
  type: 'youtube' | 'localfile' | null
  youtubeId: string | null
  fileName: string | null
  fileMime: string | null
  fileSize: number | null
}

interface Room {
  code: string
  segments: Segment[]
  nextIndex: number
  displayOrder: number[]
  members: Map<string, UserRole>  // socketId → role
  nicknames: Record<string, string>  // role → 표시이름 (예: { '속기사1': '김철수' })
  mediaState: MediaState          // 현재 재생 중인 미디어
  createdAt: number
  lastActivity: number
}

// ─── 방 관리 ─────────────────────────────────────────────────────────────────
const rooms = new Map<string, Room>()

function generateCode(): string {
  let code: string
  do {
    code = String(Math.floor(100000 + Math.random() * 900000))
  } while (rooms.has(code))
  return code
}

function getRoom(code: string): Room | undefined {
  return rooms.get(code)
}

// 비활성 방 정리 (1시간)
setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 3600000) {
      rooms.delete(code)
      console.log(`[cleanup] 방 ${code} 삭제 (비활성 1시간)`)
    }
  }
}, 60000)

// ─── 서버 시작 ───────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001

const httpServer = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(`LiveTyping Server | Rooms: ${rooms.size}`)
})

const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // 파일 전송을 위해 최대 크기를 50MB로 늘림 (기본 1MB)
  maxHttpBufferSize: 50 * 1024 * 1024
})

io.on('connection', socket => {
  let currentRoom: string | null = null
  let currentRole: UserRole | null = null

  // ─── 방 생성 ──────────────────────────────────────────────────────────
  socket.on('room:create', (
    nickname: string,
    callback: (res: { ok: boolean; code?: string }) => void
  ) => {
    const code = generateCode()
    const displayName = nickname.trim() || '속기사1'   // 이름을 안 적으면 기본값 사용
    const room: Room = {
      code,
      segments: [],
      nextIndex: 0,
      displayOrder: [],
      members: new Map([[socket.id, '속기사1']]),
      nicknames: { '속기사1': displayName },           // 닉네임 저장
      mediaState: { type: null, youtubeId: null, fileName: null, fileMime: null, fileSize: null },
      createdAt: Date.now(),
      lastActivity: Date.now()
    }
    rooms.set(code, room)
    socket.join(code)
    currentRoom = code
    currentRole = '속기사1'
    console.log(`[room] ${code} 생성 → ${displayName} (${socket.id})`)
    callback({ ok: true, code })
  })

  // ─── 방 참여 ──────────────────────────────────────────────────────────
  socket.on('room:join', (
    code: string,
    nickname: string,
    callback: (res: { ok: boolean; error?: string; role?: UserRole }) => void
  ) => {
    const room = getRoom(code)
    if (!room) {
      callback({ ok: false, error: '존재하지 않는 방 코드입니다.' })
      return
    }

    // 역할 배정: 속기사1이 이미 있으면 속기사2
    const roles = Array.from(room.members.values())
    const role: UserRole = roles.includes('속기사1') ? '속기사2' : '속기사1'
    const displayName = nickname.trim() || role       // 이름을 안 적으면 역할명 사용

    room.members.set(socket.id, role)
    room.nicknames[role] = displayName                // 닉네임 저장
    room.lastActivity = Date.now()
    socket.join(code)
    currentRoom = code
    currentRole = role

    // 현재 상태 전달 (닉네임 + 미디어 상태 포함)
    socket.emit('state:sync', {
      segments: room.segments,
      nextIndex: room.nextIndex,
      displayOrder: room.displayOrder,
      role,
      nicknames: room.nicknames,
      mediaState: room.mediaState    // 늦게 참여해도 YouTube 영상 정보를 받을 수 있음
    })

    // 상대방에게 참여 알림 (닉네임 포함)
    socket.to(code).emit('member:joined', { role, nickname: displayName })

    console.log(`[room] ${code} 참여 → ${displayName}(${role}) (${socket.id})`)
    callback({ ok: true, role })
  })

  // ─── 새 세그먼트 ──────────────────────────────────────────────────────
  socket.on('segment:new', (
    { user, content }: { user: UserRole; content: string },
    callback: (index: number) => void
  ) => {
    if (!currentRoom) return
    const room = getRoom(currentRoom)
    if (!room) return

    const index = room.nextIndex++
    room.segments.push({ index, user, content, status: 'typing' })
    room.displayOrder.push(index)
    room.lastActivity = Date.now()

    callback(index)
    broadcastState(currentRoom)
  })

  // ─── 세그먼트 업데이트 ────────────────────────────────────────────────
  socket.on('segment:update', ({ index, content, status }: {
    index: number; content: string; status: 'typing' | 'completed'
  }) => {
    if (!currentRoom) return
    const room = getRoom(currentRoom)
    if (!room) return

    const seg = room.segments.find(s => s.index === index)
    if (!seg) return
    seg.content = content
    seg.status = status
    room.lastActivity = Date.now()

    broadcastState(currentRoom)
  })

  // ─── 세그먼트 순서 변경 ──────────────────────────────────────────────
  socket.on('segment:reorder', (newOrder: number[]) => {
    if (!currentRoom) return
    const room = getRoom(currentRoom)
    if (!room) return

    room.displayOrder = newOrder
    room.lastActivity = Date.now()
    broadcastState(currentRoom)
  })

  // ─── 미디어: YouTube 동기화 ─────────────────────────────────────────
  // 속기사1이 YouTube 영상을 로드하면, videoId를 상대방에게 전달
  // 서버는 mediaState에 기억 → 늦게 참여한 사람도 state:sync로 받음
  socket.on('media:youtube', ({ videoId }: { videoId: string }) => {
    if (!currentRoom) return
    const room = getRoom(currentRoom)
    if (!room) return

    // 서버에 미디어 상태 저장 (YouTube 영상 ID만 기억)
    room.mediaState = {
      type: 'youtube',
      youtubeId: videoId,
      fileName: null,
      fileMime: null,
      fileSize: null
    }
    room.lastActivity = Date.now()

    // 나를 제외한 같은 방의 다른 사람에게 전달
    socket.to(currentRoom).emit('media:youtube', { videoId })
    console.log(`[media] ${currentRoom} YouTube: ${videoId}`)
  })

  // ─── 미디어: 로컬 파일 동기화 ──────────────────────────────────────
  // 속기사1이 파일을 불러오면, 파일 데이터를 상대방에게 전달
  // 서버는 파일 자체는 저장하지 않고, 메타데이터만 기억
  // (파일을 서버 메모리에 저장하면 메모리가 터지니까!)
  socket.on('media:localfile', (
    { fileName, mime, size, data }: {
      fileName: string; mime: string; size: number; data: Buffer
    },
    callback?: (res: { ok: boolean; error?: string }) => void
  ) => {
    if (!currentRoom) return
    const room = getRoom(currentRoom)
    if (!room) return

    // 50MB 초과 파일 거부
    if (size > 50 * 1024 * 1024) {
      callback?.({ ok: false, error: '파일이 너무 큽니다 (최대 50MB)' })
      return
    }

    // 메타데이터만 저장 (파일 바이너리는 저장 안 함)
    room.mediaState = {
      type: 'localfile',
      youtubeId: null,
      fileName,
      fileMime: mime,
      fileSize: size
    }
    room.lastActivity = Date.now()

    // 파일 데이터를 상대방에게 중계 (서버는 택배 회사 역할)
    socket.to(currentRoom).emit('media:localfile', { fileName, mime, size, data })
    callback?.({ ok: true })
    console.log(`[media] ${currentRoom} 파일: ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`)
  })

  // ─── 미디어: 닫기 ──────────────────────────────────────────────────
  socket.on('media:clear', () => {
    if (!currentRoom) return
    const room = getRoom(currentRoom)
    if (!room) return

    room.mediaState = { type: null, youtubeId: null, fileName: null, fileMime: null, fileSize: null }
    room.lastActivity = Date.now()
    socket.to(currentRoom).emit('media:clear')
  })

  // ─── 연결 끊김 ────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return
    const room = getRoom(currentRoom)
    if (!room) return

    room.members.delete(socket.id)
    socket.to(currentRoom).emit('member:left', { role: currentRole })

    console.log(`[room] ${currentRoom} 퇴장 ← ${currentRole} (${socket.id}), 남은: ${room.members.size}명`)

    // 방에 아무도 없으면 30분 후 삭제 (lastActivity 기준)
    if (room.members.size === 0) {
      room.lastActivity = Date.now()
    }
  })
})

function broadcastState(code: string): void {
  const room = getRoom(code)
  if (!room) return
  io.to(code).emit('state:sync', {
    segments: room.segments,
    nextIndex: room.nextIndex,
    displayOrder: room.displayOrder,
    nicknames: room.nicknames       // 항상 닉네임 정보도 함께 전달
  })
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`LiveTyping Server listening on :${PORT}`)
})
