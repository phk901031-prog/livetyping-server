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

interface Room {
  code: string
  segments: Segment[]
  nextIndex: number
  displayOrder: number[]
  members: Map<string, UserRole>  // socketId → role
  nicknames: Record<string, string>  // role → 표시이름 (예: { '속기사1': '김철수' })
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
  cors: { origin: '*', methods: ['GET', 'POST'] }
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

    // 현재 상태 전달 (닉네임 포함)
    socket.emit('state:sync', {
      segments: room.segments,
      nextIndex: room.nextIndex,
      displayOrder: room.displayOrder,
      role,
      nicknames: room.nicknames
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
