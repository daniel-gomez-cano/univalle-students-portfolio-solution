import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Imports de los 4 servicios AWS del reto
import * as s3 from 'aws-cdk-lib/aws-s3';                       // R1  Bucket S3
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';        // R2  Distribución CDN
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';   // R2  Origen del CDN
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';            // R3  Tabla de metadatos
import * as iam from 'aws-cdk-lib/aws-iam';                      // R4  Roles IAM
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';

/**
 * Reto 1 — Plataforma de Portafolios Estudiantiles
 * Todo en UN SOLO stack = UN SOLO `cdk deploy` (requisito R5).
 */
export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ══════════════════════════════════════════════════════════
    // R1 — BUCKET S3 PRIVADO (los archivos estáticos viven aquí)
    // ══════════════════════════════════════════════════════════
    const bucket = new s3.Bucket(this, 'PortfoliosBucket', {
      // Bloquea cualquier acceso público (ACLs o políticas abiertas) → entregar 403 al abrir el bucket a mano
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Fuerza HTTPS hacia el bucket: nadie puede leer/escribir por HTTP plano
      enforceSSL: true,
      // Al hacer `cdk destroy`, un recursosito borra los archivos antes de borrar el bucket
      // (sino S3 se niega a eliminarse y te deja la cuenta "atrapada")
      autoDeleteObjects: true,
      // Al destruir el stack, el bucket se elimina (no se retiene para evitar costos huérfanos)
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ══════════════════════════════════════════════════════════
    // BOSS FIGHT (a) — Llave de firma para Signed URLs
    // El público se sube al repo; la privada NUNCA (el .gitignore ya bloquea *.pem)
    // ══════════════════════════════════════════════════════════
    const signingPublicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      // Se lee del archivo cdk/keys/cloudfront-public.pem (generada con crypto de Node)
      encodedKey: fs.readFileSync(path.join(__dirname, '..', 'keys', 'cloudfront-public.pem'), 'utf8'),
      comment: 'Llave pública para firmar URLs de archivos privados',
    });
    // El KeyGroup agrupa las llaves públicas que CloudFront acepta como "firmantes válidos"
    const signingKeyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      items: [signingPublicKey],
    });

    // ══════════════════════════════════════════════════════════
    // R2 + BOSS FIGHT (b) — DISTRIBUCIÓN CLOUDFRONT
    // ══════════════════════════════════════════════════════════
    // Origen único S3 con OAC: CloudFront firma cada petición y S3 solo acepta a ese firmante
    // (por eso el bucket puede quedarse privado y aun así servir contenido)
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    const distribution = new cloudfront.Distribution(this, 'PortfolioDistribution', {
      // Qué archivo servir cuando piden la raíz "https://xxx/" → index.html
      defaultRootObject: 'index.html',
      // BOSS FIGHT: Norteamérica + Europa + Asia (la opción gratuita/estándar es solo N.América)
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: s3Origin,
        // HTTPS obligatorio para el visitante (redirige de http a https)
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // Política de caché estándar: guarda los objetos y los sirve desde el edge más cercano
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        // Comportamiento EXTRA solo para la carpeta 'privados/':
        // exige URL firmada (usted no firma → 403). Los archivos públicos siguen igual que antes.
        'privados/*': {
          origin: s3Origin,
          trustedKeyGroups: [signingKeyGroup], // ← aquí está el "candado" de archivos privados
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    // ══════════════════════════════════════════════════════════
    // R3 — TABLA DYNAMODB (índice consultable de portafolios)
    // ══════════════════════════════════════════════════════════
    const table = new dynamodb.Table(this, 'PortfoliosTable', {
      // Clave de partición = studentId (criterio de éxito #4) — misma key que data/portfolios.json
      partitionKey: { name: 'studentId', type: dynamodb.AttributeType.STRING },
      // "Pago por uso": sin provisionar capacidad ni pagar por reservas (serverless de verdad)
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Al destruir el stack, la tabla se borra (entorno de práctica, no producción)
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ══════════════════════════════════════════════════════════
    // R4 — ROLES IAM CON MÍNIMO PRIVILEGIO (definidos EN el stack)
    // ══════════════════════════════════════════════════════════
    // Rol 1: quien SUBE portafolios → solo puede escribir objetos en ESTE bucket
    const writerRole = new iam.Role(this, 'PortfolioWriterRole', {
      description: 'Sube archivos de portafolios al bucket (s3:PutObject)',
      // Trust policy: raíz de la cuenta puede asumirlo (en producción: usuarios/IdP concretos)
      assumedBy: new iam.AccountRootPrincipal(),
    });
    writerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        // Recurso concreto: SOLO objetos de ESTE bucket (nunca '*')
        resources: [bucket.arnForObjects('*')],
      }),
    );

    // Rol 2: quien CONSULTA metadatos → solo puede leer de ESTA tabla
    const readerRole = new iam.Role(this, 'MetadataReaderRole', {
      description: 'Lee metadatos de portafolios (dynamodb:GetItem/Query/Scan)',
      assumedBy: new iam.AccountRootPrincipal(),
    });
    readerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
        resources: [table.tableArn], // Solo esta tabla
      }),
    );

    // ══════════════════════════════════════════════════════════
    // ENTREGABLE — Ítem de prueba en DynamoDB (sin pasos manuales)
    // ══════════════════════════════════════════════════════════
    // Un "recurso personalizado" = una Lambda que CDK crea por ti y ejecuta una
    // llamada a la API de AWS (aquí: dynamodb PutItem) durante el deploy.
    // Así se cumple "tabla con al menos un ítem" dentro del MISMO `cdk deploy` (R5).
    const seedCall = {
      service: 'DynamoDB',
      action: 'putItem',
      parameters: {
        TableName: table.tableName,
        Item: {
          studentId: { S: 'univalle-2026-001' }, // ← clave de partición
          studentName: { S: 'Ana Estudiante' },
          program: { S: 'Ingeniería de Sistemas' },
          publishedAt: { S: '2026-09-19T10:00:00Z' },
          // URL real de CloudFront, resuelta en tiempo de deploy (no la conoces al escribir el código)
          url: { S: `https://${distribution.distributionDomainName}/index.html` },
          visibility: { S: 'public' },
        },
      },
      // ID fijo: si cambias los datos del ítem, CloudFormation ACTUALIZA en vez de crear otro
      physicalResourceId: PhysicalResourceId.of('seed-portfolio-univalle-2026-001'),
    };
    new AwsCustomResource(this, 'SeedPortfolioItem', {
      onCreate: seedCall,
      onUpdate: seedCall,
      // Mínimo privilegio también aquí: la Lambda solo puede hacer PutItem en ESTA tabla
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [table.tableArn] }),
    });

    // ══════════════════════════════════════════════════════════
    // OUTPUTS — lo que necesitas al terminar el deploy
    // ══════════════════════════════════════════════════════════
    // URL pública para probar (criterio de éxito #1)
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Portafolio servido por CloudFront',
    });
    // Para subir el portafolio: aws s3 cp application/ s3://<BucketName>/ --recursive
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    // Para verificar la tabla y el ítem: aws dynamodb scan --table-name <TableName>
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    // Los roles R4 (para demostrar que están en el stack y no creados a mano)
    new cdk.CfnOutput(this, 'WriterRoleArn', { value: writerRole.roleArn });
    new cdk.CfnOutput(this, 'ReaderRoleArn', { value: readerRole.roleArn });
  }
}
