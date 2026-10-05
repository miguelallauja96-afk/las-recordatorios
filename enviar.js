/* Lª S Disciplina · avisos con la app cerrada.
   cron-job.org lo hace correr CADA MINUTO (y GitHub cada 15 min como respaldo).
   Lee cada cuenta en Firebase y avisa de los bloques que tocan y no están marcados,
   y de los recordatorios de lectura de la Biblioteca.
   Para llegar a la hora exacta: prepara también los avisos del minuto siguiente
   y los envía justo cuando ese minuto empieza. */
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore(), fcm = admin.messaging();

const VENTANA = 40;          // no avisa bloques de hace más de 40 min
const CIERRE = 21 * 60 + 30; // 9:30 p. m.: aviso de cierre del día
const EMOJI = { fe: "🙏", cuerpo: "💪", trabajo: "🛵", nodo: "🔷", las: "✦", proyecto: "🚀", aprender: "📚", dinero: "💰", familia: "🏠", descanso: "🌙" };
const FRASES = ["Construye en silencio.", "Un paso más hacia tu meta.", "La disciplina te lleva lejos.", "Hazlo aunque no tengas ganas.", "Presencia antes que apariencia.", "Elige lo que te construye.", "Hoy cuenta."];
const frase = () => FRASES[Math.floor(Math.random() * FRASES.length)];
const AREAS = { fe: "Fe", cuerpo: "Cuerpo", trabajo: "Trabajo", nodo: "Nodo", las: "Lª S", proyecto: "Proyecto", aprender: "Aprender", dinero: "Dinero", familia: "Familia", descanso: "Descanso" };

function ahora(tz, fecha) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(fecha || new Date());
  const g = t => p.find(x => x.type === t).value;
  return { fecha: `${g("year")}-${g("month")}-${g("day")}`, min: +g("hour") * 60 + +g("minute"), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
}
const aMin = t => { const [h, m] = String(t || "").split(":").map(Number); return h * 60 + m; };

const espera = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const INICIO = Date.now();
const PROXIMO = Math.ceil((INICIO + 1000) / 60000) * 60000; // cuando empieza el minuto siguiente

(async () => {
  const usuarios = await db.collection("usuarios").get();
  const ya = [], luego = []; // avisos para ahora y para el minuto siguiente
  const marcas = [];
  for (const u of usuarios.docs) {
    const d = u.data(), equipos = Object.entries(d.push || {}).filter(([, v]) => v && v.token);
    if (!equipos.length) continue;
    const tz = equipos[0][1].tz || "America/Lima", n = ahora(tz);
    const sig = ahora(tz, new Date(PROXIMO)); // el minuto que viene (mismo día)
    const conSig = sig.fecha === n.fecha && sig.min === n.min + 1 && PROXIMO - Date.now() < 58000;
    const hasta = conSig ? sig.min : n.min;
    const diaSnap = await u.ref.collection("dias").doc(n.fecha).get(), dia = diaSnap.exists ? diaSnap.data() : null;
    const bloques = dia && dia.bloques ? dia.bloques : (d.perfil && d.perfil.nuevoDia === "plantilla" ? (d.rutina && d.rutina[n.dow]) || [] : []);
    const hecho = (dia && dia.done) || {};
    const env = d.pushEnv || {};
    const desde = env.fecha === n.fecha ? env.min : n.min - VENTANA;
    const enVentana = t => t >= 0 && t > desde && t <= hasta && t > n.min - VENTANA;

    const antes = parseInt(d.perfil && d.perfil.antes) || 0; // avisar X minutos antes
    const avisos = bloques
      .filter(b => enVentana(aMin(b.t) - antes) && !hecho[b.id])
      .map(b => ({ t: aMin(b.t) - antes, title: `${EMOJI[b.cat] || "⏰"} ${b.t} · ${b.task}`, body: `${antes ? "En " + antes + " min" : "Ahora"} · ${AREAS[b.cat] || "Tu día"} — ${frase()}`, tag: `${n.fecha} ${b.id}` }));

    // recordatorios de la Biblioteca (diario y por libro), guardados por la app en "avisosExtra"
    const extra = (d.avisosExtra && Array.isArray(d.avisosExtra.lista)) ? d.avisosExtra.lista : [];
    extra.filter(a => a && a.hora && enVentana(aMin(a.hora)))
      .forEach(a => avisos.push({ t: aMin(a.hora), title: a.titulo || "Lª S · Lectura", body: a.cuerpo || "Sigue leyendo", tag: `${n.fecha} ${a.id}` }));

    let cierre = env.cierre;
    if (n.min >= CIERRE && env.cierre !== n.fecha) {
      cierre = n.fecha;
      if (bloques.length) {
        const p = Math.round(bloques.filter(b => hecho[b.id]).length / bloques.length * 100);
        const metas = (d.perfil && d.perfil.metasDia) || [], cnt = (dia && dia.cnt) || {};
        const ok = metas.filter(m => (cnt[m.id] || 0) >= (m.meta || 1)).length;
        avisos.push({
          t: n.min,
          title: p >= 70 ? `Buen día: ${p}% cumplido` : `Cierra tu día: llevas ${p}%`,
          body: (metas.length ? `Metas: ${ok} de ${metas.length}. ` : "") + (p >= 70 ? "Anota tu nota del día." : "Aún puedes sumar un bloque más."),
          tag: "cierre " + n.fecha
        });
      }
    }

    for (const a of avisos) for (const [id, eq] of equipos) (a.t > n.min ? luego : ya).push({ u, id, token: eq.token, a });
    marcas.push(() => u.ref.set({ pushEnv: { fecha: n.fecha, min: hasta, cierre: cierre || null } }, { merge: true }));
  }

  let enviados = 0;
  async function enviar(lista) {
    await Promise.all(lista.map(async ({ u, id, token, a }) => {
      const { t, ...datos } = a;
      try {
        await fcm.send({ token, data: { ...datos, url: "./" }, webpush: { headers: { Urgency: "high", TTL: "1800" } } });
        enviados++;
      } catch (e) {
        if (/registration-token-not-registered|invalid-registration-token/.test(e.code || "")) {
          await u.ref.update({ ["push." + id]: admin.firestore.FieldValue.delete() }); // equipo que ya no existe
        } else console.error("Error al enviar:", e.code || e.message);
      }
    }));
  }
  await enviar(ya);
  if (luego.length) { await espera(PROXIMO - Date.now()); await enviar(luego); }
  await Promise.all(marcas.map(f => f()));
  console.log(`Listo. Avisos enviados: ${enviados} (${luego.length} a la hora exacta del minuto siguiente)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
