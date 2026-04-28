import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '../src/generated/client';

const adapter = new PrismaPg({
  connectionString: process.env['DATABASE_URL']!,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.user.findFirst({ where: { role: Role.ADMIN } });
  if (existing) {
    console.log(`Admin already exists: ${existing.email}`);
    return;
  }

  const admin = await prisma.user.create({
    data: {
      email: 'tech.admin@codekids.cc',
      password: await bcrypt.hash('1Gb128OP', 10),
      firstName: 'Tech',
      lastName: 'Admin',
      role: Role.ADMIN,
    },
  });

  console.log(`Admin created: ${admin.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
