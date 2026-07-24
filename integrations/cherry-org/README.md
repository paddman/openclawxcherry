# Cherry Organization for OpenClaw

เชื่อม OpenClaw เข้ากับโครงสร้างองค์กรสามระดับใน `paddman/C-level`:

```text
ผู้ใช้
  ↓
Cherry Agent — เลขาและหน้ารับคำสั่ง
  ↓
Rabbit Boss — แตกงาน คุม execution และ verify
  ↓
C-Level Agent — ผู้ถือหุ้น ผู้บริหาร และหัวหน้าแผนก
  ↓
DeepSeek V4 Pro / Flash
```

## บทบาท

| Agent | Model | หน้าที่ |
|---|---|---|
| Cherry (`main`) | `deepseek/deepseek-v4-flash` | รับเรื่อง ตอบงานทั่วไป และส่งงานให้ agent ที่เหมาะสม |
| Rabbit Boss | `deepseek/deepseek-v4-pro` | แตกงานหลายขั้น ใช้ tools จริง ติดตามหลักฐาน และ escalate |
| C-Level | `deepseek/deepseek-v4-pro` | เรียกประชุมผู้ถือหุ้น C-Level และหัวหน้าแผนกผ่าน localhost API |

## สิ่งที่ installer ทำ

- ติดตั้ง official DeepSeek provider ของ OpenClaw
- ตั้ง Cherry เป็น identity ของ agent `main`
- เพิ่ม agent `rabbit-boss` และ `c-level`
- ติดตั้ง workspace persona และ Skill `c-level`
- ติดตั้งคำสั่ง `$HOME/.local/bin/cherry-org`
- ติดตั้ง C-Level Python API ที่ `127.0.0.1:8787`
- สร้าง API token ใน `~/.openclaw/.env`
- ตั้ง `sessions_spawn` allowlist ให้ Cherry ส่งงานหา Rabbit Boss/C-Level
- allowlist เฉพาะ executable `cherry-org` โดยไม่เปิดกว้างให้ Python/Bash

## ติดตั้ง

ต้องมี `DEEPSEEK_API_KEY` ใน environment หรือ `~/.openclaw/.env` ก่อน:

```bash
export DEEPSEEK_API_KEY='your-key'
cd openclawxcherry
bash integrations/cherry-org/install.sh
```

ถ้า repo `C-level` อยู่คนละที่:

```bash
C_LEVEL_SOURCE_DIR=/path/to/C-level \
  bash integrations/cherry-org/install.sh
```

ถ้าต้อง clone private repo ผ่าน URL อื่น:

```bash
C_LEVEL_REPO_URL=git@github.com:paddman/C-level.git \
  bash integrations/cherry-org/install.sh
```

## ตรวจสอบ

```bash
$HOME/.local/bin/cherry-org health
$HOME/.local/bin/cherry-org route "Storage degraded ใครรับผิดชอบ"
$HOME/.local/bin/cherry-org meeting "วางแผนเปิดตัว AI Twin ภายใน 30 วัน"
openclaw agents list --bindings
openclaw skills list
openclaw gateway status
```

ทดสอบผ่าน OpenClaw:

```bash
openclaw agent --message "เชอรี่ ให้ Rabbit Boss แตกแผนเปิดตัว AI Twin และขอมติ C-Level"
```

## Runtime

### C-Level API

- `GET /health`
- `POST /v1/route`
- `POST /v1/meeting`
- Bind เริ่มต้น: `127.0.0.1:8787`
- Auth: `Authorization: Bearer $C_LEVEL_API_TOKEN`

### Service logs

systemd user service:

```bash
systemctl --user status cherry-c-level.service
journalctl --user -u cherry-c-level.service -f
```

fallback แบบไม่มี systemd:

```bash
cat ~/.local/share/cherry-org/cherry-c-level.log
```

## Security

- API bind เฉพาะ localhost เป็นค่าเริ่มต้น
- Secret อยู่ใน `~/.openclaw/.env` permission `600`
- OpenClaw ใช้ `tools.exec.mode=auto`
- Allowlist เฉพาะ `$HOME/.local/bin/cherry-org`
- ผู้ถือหุ้น เงิน สัญญา ข้อมูลส่วนบุคคล destructive action และ production change ยังต้อง human approval
