// functions/api/raid.js
const DEFAULT_SUPER_ADMIN_KEY = "admin888";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const SUPER_KEY = env.ADMIN_KEY || DEFAULT_SUPER_ADMIN_KEY;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json;charset=utf-8'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 1. GET 请求
    if (request.method === 'GET') {
      const action = url.searchParams.get('action');

      // 分支 A：获取历史团本列表
      if (action === 'list_history') {
        const { results: raids } = await db.prepare(`
          SELECT 
            r.id, r.title, r.size, r.raid_time, r.note, r.created_at,
            COUNT(s.id) as enrolled_count
          FROM raids r
          LEFT JOIN signups s ON r.id = s.raid_id
          GROUP BY r.id
          ORDER BY r.created_at DESC
          LIMIT 30
        `).all();

        return new Response(JSON.stringify({ success: true, list: raids || [] }), { headers: corsHeaders });
      }

      // 分支 B：根据 id 拉取单一团本详情
      const raidId = url.searchParams.get('id');
      if (!raidId) {
        return new Response(JSON.stringify({ error: '缺少团队ID' }), { status: 400, headers: corsHeaders });
      }

      const raid = await db.prepare("SELECT * FROM raids WHERE id = ?").bind(raidId).first();
      if (!raid) {
        return new Response(JSON.stringify({ notFound: true }), { status: 404, headers: corsHeaders });
      }

      const { results: signups } = await db.prepare(
        "SELECT slot_id, player_name, class_key, main_spec, off_spec, role, gs, note, device_id FROM signups WHERE raid_id = ?"
      ).bind(raidId).all();

      const rosterMap = {};
      for (const item of signups) {
        rosterMap[item.slot_id] = {
          name: item.player_name,
          classKey: item.class_key,
          mainSpec: item.main_spec,
          offSpec: item.off_spec || '',
          role: item.role,
          gs: item.gs,
          note: item.note || '',
          deviceId: item.device_id || ''
        };
      }

      return new Response(JSON.stringify({
        success: true,
        raid: {
          id: raid.id,
          title: raid.title,
          size: raid.size,
          tankCap: raid.tank_cap,
          healerCap: raid.healer_cap,
          time: raid.raid_time,
          note: raid.note,
          leaderName: raid.leader_name,
          createdAt: raid.created_at
        },
        rosterMap
      }), { headers: corsHeaders });
    }

    // 2. POST 请求
    if (request.method === 'POST') {
      const data = await request.json();
      const action = data.action;

      // 超级管理员验证
      if (action === 'admin_auth') {
        if (data.superKey === SUPER_KEY) {
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: '超级管理员口令错误！' }), { status: 403, headers: corsHeaders });
      }

      // 团长身份核验与换设备认领
      if (action === 'claim_leader') {
        const { raidId, adminToken } = data;
        const raid = await db.prepare("SELECT admin_token FROM raids WHERE id = ?").bind(raidId).first();
        if (raid && raid.admin_token === adminToken) {
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: '团长密钥无效，认领失败！' }), { status: 403, headers: corsHeaders });
      }

      // 超级管理员彻底删除团本
      if (action === 'admin_delete_raid') {
        if (data.superKey !== SUPER_KEY) {
          return new Response(JSON.stringify({ error: '无权操作' }), { status: 403, headers: corsHeaders });
        }
        const { targetRaidId } = data;
        await db.prepare("DELETE FROM signups WHERE raid_id = ?").bind(targetRaidId).run();
        await db.prepare("DELETE FROM raids WHERE id = ?").bind(targetRaidId).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // 保存团队配置（严格校验团长 Token）
      if (action === 'save_config') {
        const { raidId, title, size, tankCap, healerCap, time, note, adminToken } = data;
        const existing = await db.prepare("SELECT * FROM raids WHERE id = ?").bind(raidId).first();
        if (existing) {
          if (existing.admin_token !== adminToken) {
            return new Response(JSON.stringify({ error: '无开团管理权限，仅团长可修改团队配置！' }), { status: 403, headers: corsHeaders });
          }
          await db.prepare(
            "UPDATE raids SET title = ?, size = ?, tank_cap = ?, healer_cap = ?, raid_time = ?, note = ? WHERE id = ?"
          ).bind(title, size, tankCap, healerCap, time, note, raidId).run();
        } else {
          await db.prepare(
            "INSERT INTO raids (id, title, size, tank_cap, healer_cap, raid_time, note, admin_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(raidId, title, size, tankCap, healerCap, time, note, adminToken).run();
        }
        return new Response(JSON.stringify({ success: true, raidId }), { headers: corsHeaders });
      }

      // 席位登记 / 修改（单人单角色设备级限制 + 并发抢坑校验）
      if (action === 'signup') {
        const { raidId, slotId, oldSlotId, name, classKey, mainSpec, offSpec, role, gs, note, passcode, adminToken, deviceId } = data;

        if (!deviceId) {
          return new Response(JSON.stringify({ error: '无法识别设备指纹，禁止登记！' }), { status: 400, headers: corsHeaders });
        }

        const raid = await db.prepare("SELECT * FROM raids WHERE id = ?").bind(raidId).first();
        if (!raid) {
          await db.prepare(
            "INSERT INTO raids (id, title, size, tank_cap, healer_cap, raid_time, note, leader_name, admin_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(raidId, 'NAXX 开荒首通', 10, 2, 2, '周五 19:30', '', name, adminToken || '').run();
        }

        // 核心规则：同一设备单角色限制（同房间不同设备不受影响，新登记必须排他）
        if (!oldSlotId) {
          const deviceOccupied = await db.prepare(
            "SELECT player_name, slot_id FROM signups WHERE raid_id = ? AND device_id = ?"
          ).bind(raidId, deviceId).first();

          if (deviceOccupied) {
            return new Response(JSON.stringify({ 
              error: `您已在本团登记了角色【${deviceOccupied.player_name}】，每人仅限登记一个席位！如需更换请先修改或移除原席位。` 
            }), { status: 403, headers: corsHeaders });
          }
        }

        // 坑位抢占并发安全拦截
        const targetOccupy = await db.prepare("SELECT * FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, slotId).first();
        if (targetOccupy && (!oldSlotId || targetOccupy.slot_id !== oldSlotId)) {
          return new Response(JSON.stringify({ error: '该坑位已被他人抢占！' }), { status: 409, headers: corsHeaders });
        }

        // 修改时的身份权限校验
        if (oldSlotId) {
          const oldRecord = await db.prepare("SELECT * FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, oldSlotId).first();
          if (oldRecord) {
            const currentRaid = raid || await db.prepare("SELECT admin_token FROM raids WHERE id = ?").bind(raidId).first();
            const isLeader = currentRaid && currentRaid.admin_token === adminToken;
            if (!isLeader && oldRecord.passcode !== passcode) {
              return new Response(JSON.stringify({ error: '口令错误，无法修改！' }), { status: 403, headers: corsHeaders });
            }
            if (oldSlotId !== slotId) {
              await db.prepare("DELETE FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, oldSlotId).run();
            }
          }
        }

        // 写入并绑定当前设备指纹
        await db.prepare(
          `INSERT INTO signups (raid_id, slot_id, player_name, class_key, main_spec, off_spec, role, gs, note, passcode, device_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(raid_id, slot_id) DO UPDATE SET
           player_name = excluded.player_name, class_key = excluded.class_key, main_spec = excluded.main_spec,
           off_spec = excluded.off_spec, role = excluded.role, gs = excluded.gs, note = excluded.note, passcode = excluded.passcode,
           device_id = excluded.device_id`
        ).bind(raidId, slotId, name, classKey, mainSpec, offSpec, role, gs, note, passcode, deviceId).run();

        const updatedRaid = await db.prepare("SELECT leader_name FROM raids WHERE id = ?").bind(raidId).first();
        if (updatedRaid && !updatedRaid.leader_name) {
          await db.prepare("UPDATE raids SET leader_name = ? WHERE id = ?").bind(name, raidId).run();
        }

        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // 验证口令
      if (action === 'verify_passcode') {
        const { raidId, slotId, passcode, adminToken } = data;
        const raid = await db.prepare("SELECT admin_token FROM raids WHERE id = ?").bind(raidId).first();
        if (raid && raid.admin_token === adminToken) {
          return new Response(JSON.stringify({ success: true, isLeader: true }), { headers: corsHeaders });
        }

        const member = await db.prepare("SELECT passcode FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, slotId).first();
        if (member && member.passcode === passcode) {
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: '口令错误！' }), { status: 403, headers: corsHeaders });
      }

      // 移除席位登记
      if (action === 'remove_signup') {
        const { raidId, slotId, passcode, adminToken } = data;
        const raid = await db.prepare("SELECT * FROM raids WHERE id = ?").bind(raidId).first();
        const member = await db.prepare("SELECT * FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, slotId).first();
        if (!member) {
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        const isLeader = raid && raid.admin_token === adminToken;
        if (!isLeader && member.passcode !== passcode) {
          return new Response(JSON.stringify({ error: '口令错误，无法移除！' }), { status: 403, headers: corsHeaders });
        }

        await db.prepare("DELETE FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, slotId).run();

        if (raid && raid.leader_name === member.player_name) {
          const nextLeader = await db.prepare("SELECT player_name FROM signups WHERE raid_id = ? ORDER BY id ASC LIMIT 1").bind(raidId).first();
          const nextName = nextLeader ? nextLeader.player_name : '';
          await db.prepare("UPDATE raids SET leader_name = ? WHERE id = ?").bind(nextName, raidId).run();
        }

        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ error: '未知请求' }), { status: 405, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
