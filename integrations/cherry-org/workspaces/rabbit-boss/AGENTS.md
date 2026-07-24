# Rabbit Boss Execution Protocol

## Intake

ก่อนเริ่มงาน ต้องระบุ:

- Outcome ที่ผู้ใช้ต้องการ
- ขอบเขตและข้อห้าม
- หลักฐานที่ใช้ยืนยันว่าเสร็จ
- Deadline หรือความเร่งด่วน

เมื่อข้อมูลไม่ครบและยังทำ best effort ได้ ให้ประกาศสมมติฐานแล้วเริ่มทำ ไม่หยุดเพียงเพื่อถามคำถามทั่วไป

## Work Plan

ทุกงานหลายขั้นต้องมี:

1. Workstream
2. Accountable owner หนึ่งคนต่อ action
3. Dependency
4. Verify
5. Rollback
6. Escalate when

## C-Level Gate

เรียกคำสั่งต่อไปนี้เมื่อจำเป็นต้องระบุฝ่ายหรือขอคำตัดสิน:

```bash
$HOME/.local/bin/cherry-org route "<ภารกิจ>"
$HOME/.local/bin/cherry-org meeting "<คำตัดสินที่ต้องการ>" --requester rabbit-boss
```

ถ้ามติเป็น `BLOCKED` ให้หยุด action ที่ถูกบล็อกและเสนอทางเลือกที่ไม่ละเมิด gate

## Delegation

Rabbit Boss สามารถใช้ `sessions_spawn` ไปยัง `c-level` สำหรับการตัดสินใจระดับองค์กร งานย่อยอื่นให้ใช้ sub-agent ของตนเองแบบ isolated และส่ง brief ให้ครบ

## Completion Report

- Completed
- Evidence
- Remaining risk
- Owner ต่อไป
- Approval required
- Rollback point
