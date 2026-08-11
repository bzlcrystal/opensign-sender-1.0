import { NextResponse } from "next/server";

export const runtime = "nodejs";

const positions = {
  devis: { x: 166, y: 746, w: 108, h: 38 },
  resa: { x: 133, y: 686, w: 154, h: 44 }
} as const;

async function readResponse(response: Response) {
  const text = await response.text();
  try {
    return { text, data: JSON.parse(text) as unknown };
  } catch {
    return { text, data: {} };
  }
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;

  for (const key of keys) {
    if (typeof object[key] === "string") return object[key] as string;
  }

  for (const child of Object.values(object)) {
    const result = findString(child, keys);
    if (result) return result;
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const model = String(form.get("model") || "devis") as keyof typeof positions;
    const signerName = String(form.get("signerName") || "").trim();
    const signerEmail = String(form.get("signerEmail") || "").trim();
    const title = String(form.get("title") || "Document à signer").trim();

    if (!(file instanceof File) || file.type !== "application/pdf") {
      return NextResponse.json({ error: "Un fichier PDF est obligatoire." }, { status: 400 });
    }

    if (!signerName || !signerEmail) {
      return NextResponse.json({ error: "Le nom et l’e-mail sont obligatoires." }, { status: 400 });
    }

    const baseUrl = process.env.OPENSIGN_URL?.replace(/\/$/, "");
    const appId = process.env.OPENSIGN_APP_ID || "opensign";
    const userEmail = process.env.OPENSIGN_USER_EMAIL;
    const userPassword = process.env.OPENSIGN_USER_PASSWORD;

    if (!baseUrl || !userEmail || !userPassword) {
      return NextResponse.json({ error: "Variables OpenSign manquantes côté serveur." }, { status: 500 });
    }

    const commonHeaders = {
      "X-Parse-Application-Id": appId,
      Accept: "application/json"
    };

    const loginResponse = await fetch(`${baseUrl}/functions/loginuser`, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email: userEmail, password: userPassword })
    });

    const login = await readResponse(loginResponse);

    if (!loginResponse.ok) {
      return NextResponse.json(
        { error: `Connexion OpenSign ${loginResponse.status}: ${login.text.slice(0, 500)}` },
        { status: 502 }
      );
    }

    const sessionToken = findString(login.data, [
      "sessionToken",
      "session_token",
      "accesstoken",
      "accessToken"
    ]);

    if (!sessionToken) {
      return NextResponse.json(
        { error: `Aucun sessionToken reçu par OpenSign: ${login.text.slice(0, 500)}` },
        { status: 502 }
      );
    }

    // OpenSign attend d'abord un fichier Parse, puis son URL dans le document.
    const uploadedFile = await fetch(
      `${baseUrl}/files/${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: {
          ...commonHeaders,
          "Content-Type": "application/pdf",
          "X-Parse-Session-Token": sessionToken
        },
        body: Buffer.from(await file.arrayBuffer())
      }
    );

    const uploaded = await readResponse(uploadedFile);

    if (!uploadedFile.ok) {
      return NextResponse.json(
        { error: `Upload PDF OpenSign ${uploadedFile.status}: ${uploaded.text.slice(0, 700)}` },
        { status: 502 }
      );
    }

    const pdfUrl = findString(uploaded.data, ["url"]);

    if (!pdfUrl) {
      return NextResponse.json(
        { error: `OpenSign n’a pas retourné l’URL du PDF: ${uploaded.text.slice(0, 500)}` },
        { status: 502 }
      );
    }

    const position = positions[model] || positions.devis;
    const placeholderId = `sender-${Date.now()}`;

    const placeholder = {
      signerObjId: "",
      signerPtr: {},
      Id: placeholderId,
      blockColor: "#93a3db",
      Role: "Signer",
      email: signerEmail,
      placeHolder: [
        {
          pageNumber: 1,
          pos: [
            {
              type: "signature",
              x: position.x,
              y: position.y,
              w: position.w,
              h: position.h,
              key: placeholderId
            }
          ]
        }
      ]
    };

    // Ces noms avec majuscules sont ceux utilisés par contracts_Document.
    const documentPayload = {
      Name: title,
      URL: pdfUrl,
      Signers: [
        {
          Name: signerName,
          Email: signerEmail,
          Role: "Signer",
          Id: placeholderId
        }
      ],
      Placeholders: [placeholder],
      SignatureType: ["eSignature"],
      SentToOthers: true,
      SendMail: true,
      SendinOrder: false,
      SendInOrderStrict: false,
      IsEnableOTP: false,
      AllowModifications: false,
      AutomaticReminders: false,
      NotifyOnSignatures: true
    };

    const documentResponse = await fetch(
      `${baseUrl}/functions/createdocumentfromapp`,
      {
        method: "POST",
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
          "X-Parse-Session-Token": sessionToken
        },
        body: JSON.stringify({ document: documentPayload })
      }
    );

    const created = await readResponse(documentResponse);

    if (!documentResponse.ok) {
      return NextResponse.json(
        { error: `Création OpenSign ${documentResponse.status}: ${created.text.slice(0, 900)}` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      message: "Document créé et renseigné dans OpenSign.",
      url: findString(created.data, ["url", "signing_url", "signUrl", "link"]),
      response: created.data
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur serveur inconnue." },
      { status: 500 }
    );
  }
}
