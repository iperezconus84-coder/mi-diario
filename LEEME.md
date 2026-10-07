# Mi Diario: guía de instalación

Diario personal con contraseña. Todo se **cifra en tu dispositivo** (AES-256) antes de guardarse. La copia que se sincroniza a GitHub también va cifrada: sin tu contraseña es ilegible.

> ⚠️ **Si olvidas la contraseña, el diario no se puede recuperar.** Guárdala en un lugar seguro.

Necesitas una cuenta de GitHub (puede ser tu cuenta personal, **no** la de Ágape). Son unos 15 minutos, una sola vez.

---

## Paso 1. Publicar la app (repositorio público, solo código)

1. En GitHub: **New repository** → nombre `mi-diario` → **Public** → *Create repository*.
2. En el repositorio: **Add file → Upload files** y arrastra **todo el contenido** de esta carpeta (incluida la carpeta `icons`). *Commit changes*.
3. **Settings → Pages** → *Source*: **Deploy from a branch** → *Branch*: `main` / `(root)` → **Save**.
4. Espera 1–2 minutos. Tu app quedará en: `https://TU-USUARIO.github.io/mi-diario/`

Este repositorio solo contiene el código de la app. **Tus entradas nunca se guardan aquí.**

## Paso 2. Crear el repositorio privado para los datos

1. **New repository** → nombre `mi-diario-datos` → **Private** → marca *Add a README file* → *Create repository*.

Aquí se guardará un único archivo `diario.json` con tus entradas **cifradas**.

## Paso 3. Crear el token de acceso (la "llave" de sincronización)

1. Foto de perfil → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. *Token name*: `Mi Diario`. *Expiration*: 1 año (anota la fecha para renovarlo).
3. *Repository access*: **Only select repositories** → elige **solo** `mi-diario-datos`.
4. *Permissions → Repository permissions → Contents*: **Read and write**.
5. **Generate token** y copia el código (`github_pat_…`). Solo se muestra una vez.

El token queda guardado **cifrado con tu contraseña** dentro de la app.

## Paso 4. Empezar en el celular

1. Abre `https://TU-USUARIO.github.io/mi-diario/` en el celular.
2. **Empezar un diario** → crea tu contraseña.
3. **Ajustes → Sincronización**: tu usuario, `mi-diario-datos` y el token → **Guardar y sincronizar**.
4. Instálala como app:
   - **iPhone (Safari):** botón Compartir → *Agregar a pantalla de inicio*.
   - **Android (Chrome):** menú ⋮ → *Instalar aplicación*.

## Paso 5. Abrirlo en el computador

1. Abre la misma dirección en el navegador del computador.
2. **Ya tengo un diario** → usuario, `mi-diario-datos`, el token y **tu contraseña** → *Abrir mi diario*.

Desde ahí, lo que escribas en un dispositivo aparece en el otro (se sincroniza solo al escribir y al abrir la app).

---

## Recordatorio diario

**Ajustes → Recordatorio diario** → elige la hora → *Agregar a mi calendario*. Se descarga un evento que se repite cada día; ábrelo y acéptalo en tu calendario.

## Respaldo

- **Descargar respaldo cifrado:** guárdalo en Drive o en un pendrive cada cierto tiempo. Solo se abre con tu contraseña.
- **Exportar como texto:** para imprimir o releer fuera de la app. Ese archivo **no** va cifrado.

## Seguridad: lo que conviene saber

- La app se bloquea sola tras unos minutos sin uso (configurable en Ajustes).
- Nada se envía a ningún servidor salvo tu repositorio privado de GitHub, y siempre cifrado.
- Cuando el token expire, crea uno nuevo (Paso 3) y pégalo en **Ajustes → Sincronización** en cada dispositivo.
