import { NextResponse } from "next/server";

export const runtime = "nodejs";

const signaturePositions = {
  devis: { x: 166, y: 746, w: 108, h: 38 },
  resa: { x: 133, y: 686, w: 154, h: 44 }
} as const;

type ParsedResponse = {
  text: string;
  data: unknown;
};

async function parseResponse(response: Response): Promise<ParsedResponse> {
  const text = await response.text();

  try {
    return { text, data: JSON.parse(text) };
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

  return undefined;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const model = String(formData.get("model") || "devis") as keyof typeof signaturePositions;
    const signerName = String(formData.get("signerName") || "").trim();
    const signerEmail = String(formData.get("signerEmail") || "").trim();
    const title = String(formData.get("title") || "Document à signer").trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Aucun fichier PDF reçu." }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json({ error: "Le fichier doit être un PDF." }, { status: 400 });
    }

    if (!signerName || !signerEmail) {
      return NextResponse.json(
        { error: "Le nom et l’adresse e-mail du signataire sont obligatoires." },
        { status: 400 }
      );
    }

    const opensignUrl = process.env.OPENSIGN_URL?.replace(/\/$/, "");
    const applicationId = process.env.OPENSIGN_APP_ID || "opensign";
    const opensignEmail = process.env.OPENSIGN_USER_EMAIL;
    const opensignPassword = process.env.OPENSIGN_USER_PASSWORD;

    if (!opensignUrl || !opensignEmail || !opensignPassword) {
      return NextResponse.json(
        {
          error:
            "Configuration OpenSign incomplète : OPENSIGN_URL, OPENSIGN_USER_EMAIL ou OPENSIGN_USER_PASSWORD manquant."
        },
        { status: 500 }
      );
    }

    const baseHeaders = {
      "X-Parse-Application-Id": applicationId,
      Accept: "application/json"
    };

    // 1. Connexion à OpenSign avec le compte dédié.
    const loginResponse = await fetch(`${opensignUrl}/functions/loginuser`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: opensignEmail,
        password: opensignPassword
      })
    });

    const login = await parseResponse(loginResponse);

    if (!loginResponse.ok) {
      return NextResponse.json(
        {
          error: `Connexion OpenSign échouée (${loginResponse.status}) : ${login.text.slice(0, 500)}`
        },
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
        {
          error: `Aucun sessionToken retourné par OpenSign : ${login.text.slice(0, 500)}`
        },
        { status: 502 }
      );
    }

    // 2. Upload du PDF dans Parse Files.
    const uploadResponse = await fetch(
      `${opensignUrl}/files/${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/pdf",
          "X-Parse-Session-Token": sessionToken
        },
        body: Buffer.from(await file.arrayBuffer())
      }
    );

    const upload = await parseResponse(uploadResponse);

    if (!uploadResponse.ok) {
      return NextResponse.json(
        {
          error: `Upload du PDF échoué (${uploadResponse.status}) : ${upload.text.slice(0, 700)}`
        },
        { status: 502 }
      );
    }

    const pdfUrl = findString(upload.data, ["url"]);

    if (!pdfUrl) {
      return NextResponse.json(
        {
          error: `OpenSign n’a pas retourné d’URL de fichier : ${upload.text.slice(0, 500)}`
        },
        { status: 502 }
      );
    }

    // 3. Création du placeholder au format interne OpenSign.
    const position = signaturePositions[model] || signaturePositions.devis;
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

    // 4. Création du document.
    // OpenSign attend ici les noms de propriétés avec majuscules.
    const documentPayload = {
      Name: title,
      URL: pdfUrl,
      SentToOthers: true,
      SendinOrder: false,
      SendInOrderStrict: false,
      IsEnableOTP: false,
      IsTourEnabled: false,
      AllowModifications: false,
      AutomaticReminders: false,
      NotifyOnSignatures: false,
      SignatureType: ["eSignature"],
      Signers: [
        {
          Name: signerName,
          Email: signerEmail,
          Role: "Signer",
          Id: placeholderId
        }
      ],
      Placeholders: [placeholder]
    };

    const documentResponse = await fetch(
      `${opensignUrl}/functions/createdocumentfromapp`,
      {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
          "X-Parse-Session-Token": sessionToken
        },
        body: JSON.stringify({ document: documentPayload })
      }
    );

    const document = await parseResponse(documentResponse);

    if (!documentResponse.ok) {
      return NextResponse.json(
        {
          error: `Création du document échouée (${documentResponse.status}) : ${document.text.slice(0, 900)}`
        },
        { status: 502 }
      );
    }

    const documentId = findString(document.data, ["objectId"]);

    if (!documentId) {
      return NextResponse.json(
        {
          error: "OpenSign a créé le document mais aucun objectId n’a été retourné.",
          response: document.data
        },
        { status: 502 }
      );
    }

    // 5. Déclenchement explicite de l’envoi de l’e-mail.
    // createdocumentfromapp ne conserve pas toujours SendMail lors de la création.
    const sendMailResponse = await fetch(
      `${opensignUrl}/classes/contracts_Document/${documentId}`,
      {
        method: "PUT",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
          "X-Parse-Session-Token": sessionToken
        },
        body: JSON.stringify({
          SendMail: true
        })
      }
    );

    const sendMail = await parseResponse(sendMailResponse);

    if (!sendMailResponse.ok) {
      return NextResponse.json(
        {
          error: `Document créé, mais l’envoi de l’e-mail a échoué (${sendMailResponse.status}) : ${sendMail.text.slice(0, 900)}`,
          documentId,
          document: document.data
        },
        { status: 502 }
      );
    }

    const signingUrl = findString(document.data, [
      "signing_url",
      "signingUrl",
      "signUrl",
      "url",
      "link"
    ]);

    return NextResponse.json({
      message: "Document créé et e-mail de signature déclenché.",
      documentId,
      url: signingUrl,
      response: document.data,
      mailResponse: sendMail.data
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Erreur serveur inconnue."
      },
      { status: 500 }
    );
  }
}