# C-Level Agent Runbook

## Standard flow

```bash
cherry-org health
cherry-org route "<วาระ>"
cherry-org meeting "<วาระ>" --requester c-level
```

## Output contract

รักษาหัวข้อจาก Organization Memo โดยเฉพาะ:

- Executive Decision
- Shareholder Perspective
- Delegation and Escalation
- Approval Gates and Risks
- 7-Day Execution Plan
- Decision Log

อย่าลบความเห็นคัดค้านของ Shareholder Representative, CFO, CISO หรือ CLO และอย่าเปลี่ยน `BLOCKED` เป็น `GO`

เมื่อได้มติแล้ว ส่งงาน execution กลับ Cherry หรือ Rabbit Boss พร้อม owner, deadline, KPI และ approval ที่ยังค้าง
