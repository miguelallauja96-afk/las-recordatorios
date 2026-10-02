/* Lª S Disciplina · avisos con la app cerrada.
   GitHub lo corre solo cada 10 minutos. Lee cada cuenta en Firebase
   y avisa de los bloques que tocan ahora y no están marcados. */
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore(), fcm = admin.messaging();

const VENTANA = 40;          // no avisa bloques de hace más de 40 min
const CIERRE = 21 * 60 + 30; // 9:30 p. m.: aviso de cierre del día
const AREAS = { fe: "Fe", cuerpo: "Cuerpo", trabajo: "Trabajo", nodo: "Nodo", las: "Lª S", proyecto: "Proyecto", aprender: "Aprender", dinero: "Dinero", familia: "Familia", descanso: "Descanso" };

function ahora(tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { fecha: `${g("year")}-${g("month")}-${g("day")}`, min: +g("hour") * 60 + +g("minute"), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
}
const aMin = t => { const [h, m] = String(t || "").split(":").map(Number); return h * 60 + m; };

(async () => {
  const usuarios = await db.collection("usuarios").get();
  let enviados = 0;
  for (const u of usuarios.docs) {
    const d = u.data(), equipos = Object.entries(d.push || {}).filter(([, v]) => v && v.token);
    if (!equipos.length) continue;
    const tz = equipos[0][1].tz || "America/Lima", n = ahora(tz);
    const diaSnap = await u.ref.collection("dias").doc(n.fecha).get(), dia = diaSnap.exists ? diaSnap.data() : null;
    const bloques = dia && dia.bloques ? dia.bloques : (d.perfil && d.perfil.nuevoDia === "plantilla" ? (d.rutina && d.rutina[n.dow]) || [] : []);
    const hecho = (dia && dia.done) || {};
    const env = d.pushEnv || {};
    const desde = env.fecha === n.fecha ? env.min : n.min - VENTANA;

    const avisos = bloques
      .filter(b => { const t = aMin(b.t); return t > desde && t <= n.min && t > n.min - VENTANA && !hecho[b.id]; })
      .map(b => ({ title: `${b.t} · ${b.task}`, body: "Lª S · " + (AREAS[b.cat] || "Tu día"), tag: `${n.fecha} ${b.id}` }));

    let cierre = env.cierre;
    if (n.min >= CIERRE && env.cierre !== n.fecha) {
      cierre = n.fecha;
      if (bloques.length) {
        const p = Math.round(bloques.filter(b => hecho[b.id]).length / bloques.length * 100);
        const metas = (d.perfil && d.perfil.metasDia) || [], cnt = (dia && dia.cnt) || {};
        const ok = metas.filter(m => (cnt[m.id] || 0) >= (m.meta || 1)).length;
        avisos.push({
          title: p >= 70 ? `Buen día: ${p}% cumplido` : `Cierra tu día: llevas ${p}%`,
          body: (metas.length ? `Metas: ${ok} de ${metas.length}. ` : "") + (p >= 70 ? "Anota tu nota del día." : "Aún puedes sumar un bloque más."),
          tag: "cierre " + n.fecha
        });
      }
    }

    for (const a of avisos) for (const [id, eq] of equipos) {
      try {
        await fcm.send({ token: eq.token, data: { ...a, url: "./" }, webpush: { headers: { Urgency: "high", TTL: "1800" } } });
        enviados++;
      } catch (e) {
        if (/registration-token-not-registered|invalid-registration-token/.test(e.code || "")) {
          await u.ref.update({ ["push." + id]: admin.firestore.FieldValue.delete() }); // equipo que ya no existe
        } else console.error("Error al enviar:", e.code || e.message);
      }
    }
    await u.ref.set({ pushEnv: { fecha: n.fecha, min: n.min, cierre: cierre || null } }, { merge: true });
  }
  console.log(`Listo. Avisos enviados: ${enviados}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
