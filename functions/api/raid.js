// functions/api/raid.js
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);

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
    // 1. GET 请求：拉取团队数据及所有席位名单
    if (request.method === 'GET') {
      const raidId = url.searchParams.get('id');
      if (!raidId) {
        return new Response(JSON.stringify({ error: '缺少团队ID' }), { status: 400, headers: corsHeaders });
      }

      const raid = await db.prepare("SELECT * FROM raids WHERE id = ?").bind(raidId).first();
      if (!raid) {
        return new Response(JSON.stringify({ notFound: true }), { status: 404, headers: corsHeaders });
      }

      // 查询时不向全团暴露口令 passcode
      const { results: signups } = await db.prepare(
        "SELECT slot_id, player_name, class_key, main_spec, off_spec, role, gs, note FROM signups WHERE raid_id = ?"
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
          note: item.note || ''
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
          leaderName: raid.leader_name
        },
        rosterMap
      }), { headers: corsHeaders });
    }

    // 2. POST 请求：团队设置 / 席位报名 / 密码核验 / 移除席位
    if (request.method === 'POST') {
      const data = await request.json();
      const action = data.action;

      // 保存团队活动配置
      if (action === 'save_config') {
        const { raidId, title, size, tankCap, healerCap, time, note, adminToken } = data;
        const existing = await db.prepare("SELECT * FROM raids WHERE id = ?").bind(raidId).first();
        if (existing) {
          if (existing.admin_token !== adminToken) {
            return new Response(JSON.stringify({ error: '无开团管理权限' }), { status: 403, headers: corsHeaders });
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

      // 席位登记 / 修改
      if (action === 'signup') {
        const { raidId, slotId, oldSlotId, name, classKey, mainSpec, offSpec, role, gs, note, passcode, adminToken } = data;
        const targetOccupy = await db.prepare("SELECT * FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, slotId).first();
        if (targetOccupy && (!oldSlotId || targetOccupy.slot_id !== oldSlotId)) {
          return new Response(JSON.stringify({ error: '该坑位已被他人抢占！' }), { status: 409, headers: corsHeaders });
        }

        if (oldSlotId) {
          const oldRecord = await db.prepare("SELECT * FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, oldSlotId).first();
          if (oldRecord) {
            const raid = await db.prepare("SELECT admin_token FROM raids WHERE id = ?").bind(raidId).first();
            const isLeader = raid && raid.admin_token === adminToken;
            if (!isLeader && oldRecord.passcode !== passcode) {
              return new Response(JSON.stringify({ error: '口令错误，无法修改！' }), { status: 403, headers: corsHeaders });
            }
            if (oldSlotId !== slotId) {
              await db.prepare("DELETE FROM signups WHERE raid_id = ? AND slot_id = ?").bind(raidId, oldSlotId).run();
            }
          }
        }

        await db.prepare(
          `INSERT INTO signups (raid_id, slot_id, player_name, class_key, main_spec, off_spec, role, gs, note, passcode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(raid_id, slot_id) DO UPDATE SET
           player_name = excluded.player_name, class_key = excluded.class_key, main_spec = excluded.main_spec,
           off_spec = excluded.off_spec, role = excluded.role, gs = excluded.gs, note = excluded.note, passcode = excluded.passcode`
        ).bind(raidId, slotId, name, classKey, mainSpec, offSpec, role, gs, note, passcode).run();

        const raid = await db.prepare("SELECT leader_name FROM raids WHERE id = ?").bind(raidId).first();
        if (raid && !raid.leader_name) {
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

      // 移除登记
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

    return new Response(JSON.stringify({ error: '未知请求' }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
