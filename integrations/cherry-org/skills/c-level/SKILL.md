---
name: c-level
description: เรียกประชุมผู้ถือหุ้น C-Level และหัวหน้าแผนกของ Cherry เพื่อให้ได้มติ Owner KPI Deadline และแผนลงมือทำ
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [cherry-org]
---

# Cherry C-Level Organization

ใช้ Skill นี้เมื่อคำขอเกี่ยวข้องกับการตัดสินใจธุรกิจ งบประมาณ ผลิตภัณฑ์ การตลาด การขาย คน ระบบ Infra Security กฎหมาย ผู้ถือหุ้น หรือการมอบหมายงานข้ามฝ่าย

## คำสั่ง

ตรวจ service:

```bash
cherry-org health
```

ดูว่าใครควรรับผิดชอบก่อนประชุม:

```bash
cherry-org route "<คำถามหรือภารกิจของผู้ใช้>"
```

เรียกประชุมองค์กรและรับ Executive Memo:

```bash
cherry-org meeting "<คำถามหรือภารกิจของผู้ใช้>" --requester openclaw
```

บังคับบทบาทเฉพาะเมื่อผู้ใช้ระบุชัด:

```bash
cherry-org meeting "<คำถาม>" --agents shareholder_rep,ceo,cfo,cto
```

## กติกา

1. ส่งข้อความผู้ใช้ตามความหมายเดิม ห้ามแต่งตัวเลขหรือข้อเท็จจริงเพิ่มก่อนเรียก service
2. ใช้ `route` เมื่อผู้ใช้ถามว่าใครรับผิดชอบ หรือเมื่อต้องตรวจสายรายงานก่อนมอบหมาย
3. ใช้ `meeting` เมื่อผู้ใช้ต้องการคำตัดสิน แผน งานข้ามฝ่าย หรือการอนุมัติ
4. คืน memo จาก service เป็นคำตอบหลัก แล้วสรุป next action ได้ไม่เกิน 3 บรรทัด
5. ถ้า service ตอบ `BLOCKED` ห้ามเปลี่ยนเป็นอนุมัติเอง
6. การโอนเงิน เซ็นสัญญา เปลี่ยน production ลบข้อมูล ใช้ข้อมูลส่วนบุคคล และเรื่องหุ้น ต้องรอ human approval เสมอ
7. ถ้า `cherry-org health` ล้มเหลว ให้รายงานว่า C-Level service ยังไม่พร้อม พร้อม error จริง ห้ามจำลองผลประชุมขึ้นเอง
